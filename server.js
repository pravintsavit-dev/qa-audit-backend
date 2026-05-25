import express from "express";
import cors from "cors";
import multer from "multer";
import dotenv from "dotenv";
import axios from "axios";
import * as cheerio from "cheerio";
import mammoth from "mammoth";
import pdfParse from "pdf-parse";
import Groq from "groq-sdk";
import { createClient } from "@supabase/supabase-js";
import MASTER_QA_PROMPT from "./masterPrompt.js";

dotenv.config();

const app = express();

const upload = multer({
  storage: multer.memoryStorage()
});

app.use(cors());
app.use(express.json({ limit: "50mb" }));

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

app.get("/", (req, res) => {
  res.json({
    status: "QA Audit Backend is running"
  });
});

app.get("/api/audit-history", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("audit_history")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) throw error;

    res.json(data || []);
  } catch (error) {
    res.status(500).json({
      error: error.message
    });
  }
});

function cleanText(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\r/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s+/g, "\n")
    .replace(/\s+\n/g, "\n")
    .trim();
}

function cleanOneLine(value) {
  return String(value || "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function limitText(value, max = 3000) {
  const text = cleanOneLine(value);

  if (text.length <= max) return text;

  return text.slice(0, max) + " ...[truncated]";
}

function uniqueStrings(items) {
  const seen = new Set();
  const output = [];

  items.forEach(item => {
    const text = cleanOneLine(item);

    if (!text) return;

    const key = text.toLowerCase();

    if (!seen.has(key)) {
      seen.add(key);
      output.push(text);
    }
  });

  return output;
}

function extractTextList($, selector, maxItems = 40, maxLength = 260) {
  const values = [];

  $(selector).each((_, el) => {
    const text = cleanOneLine($(el).text());

    if (text && text.length > 1) {
      values.push(limitText(text, maxLength));
    }
  });

  return uniqueStrings(values).slice(0, maxItems);
}

async function extractLivePageText(url) {
  try {
    const response = await axios.get(url, {
      timeout: 30000,
      headers: {
        "User-Agent": "Mozilla/5.0 QA-Audit-Bot"
      }
    });

    const $ = cheerio.load(response.data);

    $("script, style, noscript, svg, iframe, .popup, .modal, .cookie-banner, .newsletter-popup").remove();

    const title = cleanOneLine($("title").first().text());

    const metaDescription =
      cleanOneLine($('meta[name="description"]').attr("content")) ||
      cleanOneLine($('meta[property="og:description"]').attr("content")) ||
      "";

    const metaTitle =
      cleanOneLine($('meta[property="og:title"]').attr("content")) ||
      title;

    let headerText = "";
    $("header").each((_, el) => {
      headerText += " " + cleanOneLine($(el).text());
    });

    let navText = "";
    $("nav").each((_, el) => {
      navText += " " + cleanOneLine($(el).text());
    });

    let footerText = "";
    $("footer").each((_, el) => {
      footerText += " " + cleanOneLine($(el).text());
    });

    const heroHeading = cleanOneLine($("h1").first().text());

    let heroSubheading = "";
    const heroSection = $("h1").first().closest("section, div");

    if (heroSection.length) {
      heroSubheading = cleanOneLine(heroSection.find("p").first().text());
    }

    const h1 = extractTextList($, "h1", 10, 260);
    const h2 = extractTextList($, "h2", 40, 260);
    const h3 = extractTextList($, "h3", 40, 260);
    const headings = uniqueStrings([...h1, ...h2, ...h3]);

    const bodyClone = $("body").clone();
    bodyClone.find("header, nav, footer, script, style, noscript, svg, iframe").remove();

    const mainVisibleText = $("main").length
      ? cleanOneLine($("main").text())
      : cleanOneLine(bodyClone.text());

    const fullVisibleText = cleanOneLine($("body").text());

    const mainButtons = [];

    bodyClone.find("a, button, input[type='button'], input[type='submit']").each((_, el) => {
      const node = $(el);

      const text =
        cleanOneLine(node.text()) ||
        cleanOneLine(node.attr("value")) ||
        cleanOneLine(node.attr("aria-label"));

      const href = node.attr("href") || "";

      if (text && text.length <= 120) {
        mainButtons.push({
          text,
          href
        });
      }
    });

    return {
      url,
      meta: {
        title,
        metaTitle,
        metaDescription
      },
      hero: {
        heading: heroHeading,
        subheading: heroSubheading
      },
      headings: headings.slice(0, 50),
      mainButtons: mainButtons.slice(0, 30),
      mainVisibleText: limitText(mainVisibleText, 9000),
      fullVisibleText: limitText(fullVisibleText, 11000),
      globalComponents: {
        headerText: limitText(headerText, 1500),
        navText: limitText(navText, 1500),
        footerText: limitText(footerText, 2000)
      }
    };
  } catch (error) {
    return {
      url,
      error: `Could not access live page: ${error.message}`,
      meta: {},
      hero: {},
      headings: [],
      mainButtons: [],
      mainVisibleText: "",
      fullVisibleText: "",
      globalComponents: {}
    };
  }
}

async function extractFileText(file) {
  const name = file.originalname;
  const lower = name.toLowerCase();

  try {
    if (lower.endsWith(".docx")) {
      const result = await mammoth.extractRawText({
        buffer: file.buffer
      });

      return {
        fileName: name,
        text: result.value || ""
      };
    }

    if (lower.endsWith(".pdf")) {
      const result = await pdfParse(file.buffer);

      return {
        fileName: name,
        text: result.text || ""
      };
    }

    if (lower.endsWith(".json")) {
      return {
        fileName: name,
        text: file.buffer.toString("utf8")
      };
    }

    return {
      fileName: name,
      text: file.buffer.toString("utf8")
    };
  } catch (error) {
    return {
      fileName: name,
      text: `Could not extract file text: ${error.message}`
    };
  }
}

function normalizeForMatch(value) {
  return cleanOneLine(value)
    .toLowerCase()
    .replace(/https?:\/\//g, "")
    .replace(/www\./g, "")
    .replace(/\.[a-z0-9]+/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function getUrlTokens(url) {
  try {
    const parsed = new URL(url);

    const pathTokens = parsed.pathname
      .split("/")
      .filter(Boolean)
      .join(" ");

    return normalizeForMatch(`${parsed.hostname} ${pathTokens}`)
      .split(" ")
      .filter(token => token.length > 2);
  } catch {
    return normalizeForMatch(url)
      .split(" ")
      .filter(token => token.length > 2);
  }
}

function scoreFileForUrl(url, fileName) {
  const fileText = normalizeForMatch(fileName);
  const tokens = getUrlTokens(url);

  let score = 0;

  tokens.forEach(token => {
    if (fileText.includes(token)) {
      score += token.length > 4 ? 3 : 1;
    }
  });

  return score;
}

function getRelevantFilesForUrl(url, files, maxFiles = 1) {
  if (!files.length) return [];
  if (files.length === 1) return files;

  const scored = files
    .map(file => ({
      file,
      score: scoreFileForUrl(url, file.fileName || "")
    }))
    .sort((a, b) => b.score - a.score);

  const matched = scored.filter(item => item.score > 0);

  if (matched.length) {
    return matched.slice(0, maxFiles).map(item => item.file);
  }

  return scored.slice(0, 1).map(item => item.file);
}

function compactFileText(file, maxChars = 9000) {
  return {
    fileName: file.fileName,
    text: limitText(file.text, maxChars)
  };
}

function compactLivePageForAi(page) {
  return {
    url: page.url,
    meta: page.meta || {},
    hero: page.hero || {},
    headings: (page.headings || []).slice(0, 50),
    mainButtons: (page.mainButtons || []).slice(0, 30),
    mainVisibleText: limitText(page.mainVisibleText || "", 9000),
    globalComponents: {
      headerText: limitText(page.globalComponents?.headerText || "", 1200),
      navText: limitText(page.globalComponents?.navText || "", 1200),
      footerText: limitText(page.globalComponents?.footerText || "", 1600)
    }
  };
}

function makeSafeFileName(url) {
  try {
    const parsed = new URL(url);

    const domain = parsed.hostname
      .replace("www.", "")
      .replace(/[^a-z0-9]/gi, "-");

    const path = parsed.pathname
      .replace(/[^a-z0-9]/gi, "-")
      .replace(/-+/g, "-");

    return `${domain}${path}-${Date.now()}.png`;
  } catch {
    return `qa-screenshot-${Date.now()}.png`;
  }
}

async function capturePageScreenshot(url) {
  try {
    if (!process.env.BROWSERLESS_TOKEN) {
      return {
        captured: false,
        viewport: "1920x1080",
        imageUrl: "",
        notes: "Browserless token not configured."
      };
    }

    const screenshotUrl =
      `https://production-sfo.browserless.io/screenshot?token=${process.env.BROWSERLESS_TOKEN}`;

    const response = await axios.post(
      screenshotUrl,
      {
        url,
        gotoOptions: {
          waitUntil: "networkidle2",
          timeout: 60000
        },
        viewport: {
          width: 1920,
          height: 1080,
          deviceScaleFactor: 1,
          isMobile: false,
          hasTouch: false,
          isLandscape: true
        },
        bestAttempt: true,
        waitForTimeout: 5000,
        options: {
          fullPage: true,
          type: "png"
        }
      },
      {
        responseType: "arraybuffer",
        timeout: 90000
      }
    );

    const imageBuffer = Buffer.from(response.data);
    const fileName = makeSafeFileName(url);

    const { error } = await supabase
      .storage
      .from("qa-screenshots")
      .upload(fileName, imageBuffer, {
        contentType: "image/png",
        upsert: true
      });

    if (error) throw error;

    const { data } = supabase
      .storage
      .from("qa-screenshots")
      .getPublicUrl(fileName);

    return {
      captured: true,
      viewport: "1920x1080",
      imageUrl: data.publicUrl,
      notes: "Full-page screenshot uploaded successfully."
    };
  } catch (error) {
    return {
      captured: false,
      viewport: "1920x1080",
      imageUrl: "",
      notes: `Screenshot capture failed: ${error.message}`
    };
  }
}

function extractJsonFromAiOutput(output) {
  const cleaned = String(output || "")
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();

  try {
    return JSON.parse(cleaned);
  } catch {
    const firstBrace = cleaned.indexOf("{");
    const lastBrace = cleaned.lastIndexOf("}");

    if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
      const jsonOnly = cleaned.slice(firstBrace, lastBrace + 1);
      return JSON.parse(jsonOnly);
    }

    throw new Error("AI did not return valid JSON.");
  }
}

async function saveAuditHistory(urls, reportJson) {
  try {
    const firstUrl = urls[0] || "Unknown URL";

    const auditName = firstUrl
      .replace(/^https?:\/\//, "")
      .replace(/\/$/, "");

    await supabase
      .from("audit_history")
      .insert([
        {
          audit_name: auditName,
          url: firstUrl,
          result: reportJson.overallResult || "UNKNOWN",
          report_json: reportJson
        }
      ]);
  } catch (error) {
    console.error("Audit history save failed:", error.message);
  }
}

function buildNoSourceReport(url, screenshotResult) {
  return {
    page: url,
    sourceFile: "Not provided",
    jsonFile: "Optional / Not provided",
    result: "FAIL",
    mainIssue: "No source DOCX/PDF/XD file provided for strict comparison",
    sections: [
      {
        section: "Source Availability",
        severity: "HIGH",
        jsonStatus: "Optional / Not provided",
        liveStatus: "Not compared",
        result: "FAIL",
        notes: "A live URL was provided, but no DOCX/PDF/XD source file was uploaded. Strict content QA requires a source file."
      }
    ],
    missingContent: [],
    duplicatedContent: [],
    extraContent: [],
    modifiedContent: [],
    placementIssues: [],
    whatToChange: [
      "Upload the matching DOCX/PDF source file or design PDF/XD file for this page."
    ],
    screenshotQA: screenshotResult || {
      captured: false,
      viewport: "1920x1080",
      imageUrl: "",
      notes: "Screenshot not available."
    }
  };
}

async function auditSinglePage({
  url,
  livePage,
  screenshotResult,
  sourceFiles,
  jsonFiles,
  designFiles
}) {
  const relevantSourceFiles = getRelevantFilesForUrl(url, sourceFiles, 1);
  const relevantJsonFiles = getRelevantFilesForUrl(url, jsonFiles, 1);
  const relevantDesignFiles = getRelevantFilesForUrl(url, designFiles, 1);

  if (!relevantSourceFiles.length && !relevantDesignFiles.length) {
    return buildNoSourceReport(url, screenshotResult);
  }

  const prompt = `
${MASTER_QA_PROMPT}

AUDIT ONLY THIS ONE PAGE:
${url}

SOURCE DOC/PDF FILE:
${JSON.stringify(relevantSourceFiles.map(file => compactFileText(file, 9000)), null, 2)}

DESIGN PDF/XD FILE:
${JSON.stringify(relevantDesignFiles.map(file => compactFileText(file, 7000)), null, 2)}

ELEMENTOR JSON SUPPORT:
${JSON.stringify(relevantJsonFiles.map(file => compactFileText(file, 4000)), null, 2)}

LIVE PAGE DATA:
${JSON.stringify(compactLivePageForAi(livePage), null, 2)}

SCREENSHOT QA:
${JSON.stringify(
    {
      url,
      captured: screenshotResult.captured,
      viewport: screenshotResult.viewport,
      imageUrl: screenshotResult.imageUrl,
      notes: screenshotResult.notes
    },
    null,
    2
  )}
`;

  const completion = await groq.chat.completions.create({
    model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
    messages: [
      {
        role: "system",
        content: "Return only valid JSON. No markdown. No headings. No explanation outside JSON."
      },
      {
        role: "user",
        content: prompt
      }
    ],
    temperature: 0
  });

  const output = completion.choices[0].message.content;
  const json = extractJsonFromAiOutput(output);

  let pageReport;

  if (Array.isArray(json.pages) && json.pages.length) {
    pageReport = json.pages[0];
  } else {
    pageReport = {
      page: url,
      sourceFile: relevantSourceFiles[0]?.fileName || relevantDesignFiles[0]?.fileName || "Not provided",
      jsonFile: relevantJsonFiles[0]?.fileName || "Optional / Not provided",
      result: json.overallResult || "FAIL",
      mainIssue: "AI returned incomplete page report",
      sections: [],
      missingContent: [],
      duplicatedContent: [],
      extraContent: [],
      modifiedContent: [],
      placementIssues: [],
      whatToChange: []
    };
  }

  return {
    ...pageReport,
    page: pageReport.page || url,
    sourceFile:
      pageReport.sourceFile ||
      relevantSourceFiles[0]?.fileName ||
      relevantDesignFiles[0]?.fileName ||
      "Not provided",
    jsonFile:
      pageReport.jsonFile ||
      relevantJsonFiles[0]?.fileName ||
      "Optional / Not provided",
    screenshotQA: screenshotResult
  };
}

app.post(
  "/api/run-qa-audit",
  upload.fields([
    { name: "contentFiles", maxCount: 30 },
    { name: "jsonFiles", maxCount: 30 },
    { name: "designFiles", maxCount: 30 }
  ]),
  async (req, res) => {
    try {
      const urls = JSON.parse(req.body.urls || "[]");

      if (!urls.length) {
        return res.status(400).json({
          error: "At least one live URL is required."
        });
      }

      const contentFiles = req.files?.contentFiles || [];
      const jsonFileUploads = req.files?.jsonFiles || [];
      const designFileUploads = req.files?.designFiles || [];

      const livePages = await Promise.all(urls.map(extractLivePageText));
      const screenshotResults = await Promise.all(urls.map(capturePageScreenshot));

      const sourceTexts = await Promise.all(contentFiles.map(extractFileText));
      const jsonTexts = await Promise.all(jsonFileUploads.map(extractFileText));
      const designTexts = await Promise.all(designFileUploads.map(extractFileText));

      const pages = [];

      for (let i = 0; i < urls.length; i++) {
        const pageReport = await auditSinglePage({
          url: urls[i],
          livePage: livePages[i],
          screenshotResult: screenshotResults[i],
          sourceFiles: sourceTexts,
          jsonFiles: jsonTexts,
          designFiles: designTexts
        });

        pages.push(pageReport);
      }

      const overallResult =
        pages.every(page => page.result === "PASS")
          ? "PASS"
          : "FAIL";

      const reportJson = {
        overallResult,
        pages
      };

      await saveAuditHistory(urls, reportJson);

      res.json(reportJson);
    } catch (error) {
      console.error(error);

      res.status(500).json({
        overallResult: "FAIL",
        error: error.message
      });
    }
  }
);

const PORT = process.env.PORT || 10000;

app.listen(PORT, () => {
  console.log(`QA Audit Backend running on port ${PORT}`);
});
