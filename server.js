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
    .replace(/\s+/g, " ")
    .trim();
}

function limitText(value, max = 5000) {
  const text = cleanText(value);

  if (text.length <= max) return text;

  return text.slice(0, max) + " ...[truncated]";
}

function uniqueStrings(items) {
  const seen = new Set();
  const output = [];

  items.forEach(item => {
    const text = cleanText(item);

    if (!text) return;

    const key = text.toLowerCase();

    if (!seen.has(key)) {
      seen.add(key);
      output.push(text);
    }
  });

  return output;
}

function extractTextList($, selector, maxItems = 50, maxLength = 300) {
  const values = [];

  $(selector).each((_, el) => {
    const text = cleanText($(el).text());

    if (text && text.length > 1) {
      values.push(limitText(text, maxLength));
    }
  });

  return uniqueStrings(values).slice(0, maxItems);
}

function extractCtas($) {
  const ctas = [];

  $("a, button, input[type='button'], input[type='submit']").each((_, el) => {
    const node = $(el);

    const text =
      cleanText(node.text()) ||
      cleanText(node.attr("value")) ||
      cleanText(node.attr("aria-label"));

    const href = node.attr("href") || "";

    if (!text) return;

    const lower = text.toLowerCase();

    const looksLikeCta =
      lower.includes("book") ||
      lower.includes("appointment") ||
      lower.includes("request") ||
      lower.includes("schedule") ||
      lower.includes("contact") ||
      lower.includes("call") ||
      lower.includes("learn") ||
      lower.includes("consult") ||
      lower.includes("start") ||
      lower.includes("visit") ||
      node.is("button") ||
      node.attr("type") === "submit";

    if (!looksLikeCta && text.length > 40) return;

    ctas.push({
      text: limitText(text, 160),
      href,
      tag: el.tagName || ""
    });
  });

  const seen = new Set();

  return ctas.filter(cta => {
    const key = `${cta.text}|${cta.href}`.toLowerCase();

    if (seen.has(key)) return false;

    seen.add(key);

    return true;
  }).slice(0, 40);
}

function extractFaqs($) {
  const faqs = [];

  $("details").each((_, el) => {
    const question = cleanText($(el).find("summary").first().text());
    const answer = cleanText($(el).text()).replace(question, "").trim();

    if (question || answer) {
      faqs.push({
        question: limitText(question, 250),
        answer: limitText(answer, 1200),
        source: "details"
      });
    }
  });

  $(".elementor-accordion-item, .elementor-toggle-item, .accordion-item, .faq-item, [class*='faq'], [class*='accordion']").each((_, el) => {
    const item = $(el);

    const question =
      cleanText(item.find(".elementor-tab-title").first().text()) ||
      cleanText(item.find(".accordion-title").first().text()) ||
      cleanText(item.find(".faq-question").first().text()) ||
      cleanText(item.find("h2,h3,h4,button").first().text());

    let answer =
      cleanText(item.find(".elementor-tab-content").first().text()) ||
      cleanText(item.find(".accordion-content").first().text()) ||
      cleanText(item.find(".faq-answer").first().text());

    if (!answer) {
      const allText = cleanText(item.text());

      if (question && allText.includes(question)) {
        answer = cleanText(allText.replace(question, ""));
      } else {
        answer = allText;
      }
    }

    if ((question && question.length > 3) || answer.length > 20) {
      faqs.push({
        question: limitText(question, 250),
        answer: limitText(answer, 1200),
        source: "accordion/faq"
      });
    }
  });

  const seen = new Set();

  return faqs.filter(faq => {
    const key = `${faq.question}|${faq.answer}`.toLowerCase();

    if (!faq.question && !faq.answer) return false;
    if (seen.has(key)) return false;

    seen.add(key);

    return true;
  }).slice(0, 40);
}

function extractReviews($) {
  const reviews = [];

  $(
    ".review, .testimonial, .swiper-slide, [class*='review'], [class*='testimonial'], [class*='rating']"
  ).each((_, el) => {
    const item = $(el);
    const text = cleanText(item.text());

    if (text.length < 20) return;

    const author =
      cleanText(item.find(".author,.name,.reviewer,[class*='author'],[class*='name']").first().text()) ||
      "";

    reviews.push({
      author: limitText(author, 120),
      text: limitText(text, 1600)
    });
  });

  const seen = new Set();

  return reviews.filter(review => {
    const key = review.text.toLowerCase();

    if (seen.has(key)) return false;

    seen.add(key);

    return true;
  }).slice(0, 25);
}

function extractBenefitCards($) {
  const cards = [];

  $(
    ".elementor-icon-box-wrapper, .elementor-widget-icon-box, .card, .benefit, [class*='benefit'], [class*='icon-box']"
  ).each((_, el) => {
    const item = $(el);

    const title =
      cleanText(item.find(".elementor-icon-box-title").first().text()) ||
      cleanText(item.find("h2,h3,h4,strong").first().text());

    const description =
      cleanText(item.find(".elementor-icon-box-description").first().text()) ||
      cleanText(item.find("p").first().text());

    const fullText = cleanText(item.text());

    if (fullText.length < 5 || fullText.length > 800) return;

    cards.push({
      title: limitText(title, 160),
      description: limitText(description, 500),
      text: limitText(fullText, 800)
    });
  });

  const seen = new Set();

  return cards.filter(card => {
    const key = card.text.toLowerCase();

    if (seen.has(key)) return false;

    seen.add(key);

    return true;
  }).slice(0, 30);
}

function extractProcessSteps($) {
  const steps = [];

  $("ol li").each((index, el) => {
    const text = cleanText($(el).text());

    if (text.length > 5) {
      steps.push({
        number: index + 1,
        text: limitText(text, 1000),
        source: "ordered-list"
      });
    }
  });

  $(".elementor-accordion-item, .accordion-item, .step, [class*='step'], [class*='process']").each((index, el) => {
    const text = cleanText($(el).text());

    if (text.length > 10 && text.length < 1800) {
      steps.push({
        number: index + 1,
        text: limitText(text, 1000),
        source: "accordion/process"
      });
    }
  });

  const seen = new Set();

  return steps.filter(step => {
    const key = step.text.toLowerCase();

    if (seen.has(key)) return false;

    seen.add(key);

    return true;
  }).slice(0, 30);
}

function extractSections($) {
  const sections = [];

  $("h1, h2, h3").each((_, el) => {
    const headingNode = $(el);

    const heading = cleanText(headingNode.text());
    const level = String(el.tagName || "").toUpperCase();

    if (!heading || heading.length < 2) return;

    let sectionText = "";

    const closestSection = headingNode.closest("section");

    if (closestSection.length) {
      sectionText = cleanText(closestSection.text());
    }

    if (!sectionText || sectionText.length < heading.length + 20) {
      const parent = headingNode.parent();
      sectionText = cleanText(parent.text());
    }

    if (!sectionText || sectionText.length < heading.length + 20) {
      let siblingText = "";

      let next = headingNode.next();

      while (next.length) {
        const tag = String(next[0].tagName || "").toLowerCase();

        if (["h1", "h2", "h3"].includes(tag)) break;

        siblingText += " " + cleanText(next.text());

        next = next.next();
      }

      sectionText = `${heading} ${siblingText}`;
    }

    sections.push({
      heading,
      level,
      text: limitText(sectionText, 2500)
    });
  });

  const seen = new Set();

  return sections.filter(section => {
    const key = `${section.level}|${section.heading}|${section.text.slice(0, 120)}`.toLowerCase();

    if (seen.has(key)) return false;

    seen.add(key);

    return true;
  }).slice(0, 35);
}

function extractContactDetails($, fullText) {
  const phoneMatches =
    fullText.match(/(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g) || [];

  const emailMatches =
    fullText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];

  const addressCandidates = [];

  $("[class*='address'], address, footer").each((_, el) => {
    const text = cleanText($(el).text());

    if (text.length > 10) {
      addressCandidates.push(limitText(text, 500));
    }
  });

  return {
    phones: uniqueStrings(phoneMatches),
    emails: uniqueStrings(emailMatches),
    addresses: uniqueStrings(addressCandidates).slice(0, 10)
  };
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

    const title = cleanText($("title").first().text());

    const metaDescription =
      cleanText($('meta[name="description"]').attr("content")) ||
      cleanText($('meta[property="og:description"]').attr("content")) ||
      "";

    const metaTitle =
      cleanText($('meta[property="og:title"]').attr("content")) ||
      title;

    let headerText = "";

    $("header").each((_, el) => {
      headerText += " " + cleanText($(el).text());
    });

    let navText = "";

    $("nav").each((_, el) => {
      navText += " " + cleanText($(el).text());
    });

    let footerText = "";

    $("footer").each((_, el) => {
      footerText += " " + cleanText($(el).text());
    });

    const heroHeading = cleanText($("h1").first().text());

    let heroSubheading = "";
    const heroSection = $("h1").first().closest("section, div");

    if (heroSection.length) {
      heroSubheading = cleanText(heroSection.find("p").first().text());
    }

    const h1 = extractTextList($, "h1", 20, 300);
    const h2 = extractTextList($, "h2", 60, 300);
    const h3 = extractTextList($, "h3", 80, 300);

    const headings = uniqueStrings([...h1, ...h2, ...h3]);

    const pageClone = $("body").clone();

    pageClone.find("header, nav, footer, script, style, noscript, svg, iframe").remove();

    let mainContent = "";

    if ($("main").length) {
      mainContent = cleanText($("main").text());
    } else {
      mainContent = cleanText(pageClone.text());
    }

    const fullBodyText = cleanText($("body").text());

    const structuredContent = {
      meta: {
        title,
        metaTitle,
        metaDescription
      },

      hero: {
        heading: heroHeading,
        subheading: heroSubheading
      },

      headingHierarchy: {
        h1,
        h2,
        h3,
        all: headings
      },

      sections: extractSections($),

      ctas: extractCtas($),

      benefits: extractBenefitCards($),

      processSteps: extractProcessSteps($),

      faqs: extractFaqs($),

      reviews: extractReviews($),

      contactDetails: extractContactDetails($, fullBodyText),

      globalComponents: {
        headerText: limitText(headerText, 3000),
        navText: limitText(navText, 3000),
        footerText: limitText(footerText, 4000)
      },

      pageBody: {
        mainContent: limitText(mainContent, 22000),
        fullBodyText: limitText(fullBodyText, 26000)
      }
    };

    return {
      url,

      title,
      metaDescription,

      heroHeading,
      heroSubheading,

      h1,
      h2,
      h3,
      headings,

      headerText: limitText(headerText, 3000),
      navText: limitText(navText, 3000),
      mainContent: limitText(mainContent, 22000),
      footerText: limitText(footerText, 4000),

      faqs: structuredContent.faqs,
      reviews: structuredContent.reviews,

      bodyText: limitText(mainContent, 22000),
      fullBodyText: limitText(fullBodyText, 26000),

      structuredContent
    };
  } catch (error) {
    return {
      url,
      error: `Could not access live page: ${error.message}`,
      title: "",
      metaDescription: "",
      heroHeading: "",
      heroSubheading: "",
      h1: [],
      h2: [],
      h3: [],
      headings: [],
      headerText: "",
      navText: "",
      mainContent: "",
      footerText: "",
      faqs: [],
      reviews: [],
      bodyText: "",
      fullBodyText: "",
      structuredContent: {}
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
      const jsonFiles = req.files?.jsonFiles || [];
      const designFiles = req.files?.designFiles || [];

      const livePages = await Promise.all(urls.map(extractLivePageText));
      const screenshotResults = await Promise.all(urls.map(capturePageScreenshot));
      const sourceTexts = await Promise.all(contentFiles.map(extractFileText));
      const jsonTexts = await Promise.all(jsonFiles.map(extractFileText));
      const designTexts = await Promise.all(designFiles.map(extractFileText));

      const prompt = `
${MASTER_QA_PROMPT}

IMPORTANT STRUCTURED EXTRACTION NOTE:
The LIVE PAGES data includes structuredContent with:
- meta
- hero
- headingHierarchy
- sections
- ctas
- benefits
- processSteps
- faqs
- reviews
- contactDetails
- globalComponents
- pageBody

Use these structured chunks for forensic comparison.
Compare FAQs individually.
Compare reviews individually.
Compare CTA buttons individually.
Compare benefit cards individually.
Compare process steps individually.
Compare header/footer/global components only when source/design/JSON includes global component expectations.

LIVE PAGES:
${JSON.stringify(livePages, null, 2)}

SCREENSHOT QA:
${JSON.stringify(
  screenshotResults.map((shot, index) => ({
    url: urls[index],
    captured: shot.captured,
    viewport: shot.viewport,
    imageUrl: shot.imageUrl,
    notes: shot.notes
  })),
  null,
  2
)}

SOURCE DOC/PDF FILE TEXT:
${JSON.stringify(sourceTexts, null, 2)}

ELEMENTOR JSON TEXT:
${JSON.stringify(jsonTexts, null, 2)}

DESIGN FILE TEXT:
${JSON.stringify(designTexts, null, 2)}
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

      if (Array.isArray(json.pages)) {
        json.pages = json.pages.map((page, index) => ({
          ...page,
          screenshotQA: screenshotResults[index] || {
            captured: false,
            viewport: "1920x1080",
            imageUrl: "",
            notes: "Screenshot not available."
          }
        }));
      }

      await saveAuditHistory(urls, json);

      res.json(json);
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
