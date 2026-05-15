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

async function extractLivePageText(url) {
  try {
    const response = await axios.get(url, {
      timeout: 20000,
      headers: {
        "User-Agent": "Mozilla/5.0 QA-Audit-Bot"
      }
    });

    const $ = cheerio.load(response.data);

    $("script, style, noscript, svg").remove();

    const title = $("title").text().trim();
    const h1 = $("h1").map((_, el) => $(el).text().trim()).get();
    const h2 = $("h2").map((_, el) => $(el).text().trim()).get();
    const bodyText = $("body").text().replace(/\s+/g, " ").trim();

    return {
      url,
      title,
      h1,
      h2,
      bodyText
    };
  } catch (error) {
    return {
      url,
      error: `Could not access live page: ${error.message}`,
      bodyText: ""
    };
  }
}

async function extractFileText(file) {
  const name = file.originalname;
  const lower = name.toLowerCase();

  try {
    if (lower.endsWith(".docx")) {
      const result = await mammoth.extractRawText({ buffer: file.buffer });

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

        waitForTimeout: 3000,

        evaluate: async () => {
          function wait(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
          }

          async function autoScrollPage() {
            const totalHeight = Math.max(
              document.body.scrollHeight,
              document.documentElement.scrollHeight
            );

            const step = Math.max(window.innerHeight * 0.75, 600);
            let currentPosition = 0;

            while (currentPosition < totalHeight) {
              window.scrollTo(0, currentPosition);
              await wait(700);
              currentPosition += step;
            }

            window.scrollTo(0, totalHeight);
            await wait(1200);
            window.scrollTo(0, 0);
            await wait(1500);
          }

          function forceLazyImages() {
            document.querySelectorAll("img").forEach(img => {
              const lazySrc =
                img.getAttribute("data-src") ||
                img.getAttribute("data-lazy-src") ||
                img.getAttribute("data-original") ||
                img.getAttribute("data-srcset");

              if (lazySrc && !img.getAttribute("src")) {
                img.setAttribute("src", lazySrc);
              }

              if (img.dataset && img.dataset.src) {
                img.src = img.dataset.src;
              }

              img.loading = "eager";
              img.decoding = "sync";
            });

            document.querySelectorAll("source").forEach(source => {
              const lazySrcset =
                source.getAttribute("data-srcset") ||
                source.getAttribute("data-lazy-srcset");

              if (lazySrcset && !source.getAttribute("srcset")) {
                source.setAttribute("srcset", lazySrcset);
              }
            });
          }

          forceLazyImages();
          await autoScrollPage();
          forceLazyImages();

          await Promise.all(
            Array.from(document.images).map(img => {
              if (img.complete) return Promise.resolve();

              return new Promise(resolve => {
                img.onload = resolve;
                img.onerror = resolve;
                setTimeout(resolve, 5000);
              });
            })
          );

          await document.fonts.ready;
          await wait(3000);

          window.scrollTo(0, 0);
        },

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

    if (error) {
      throw error;
    }

    const { data } = supabase
      .storage
      .from("qa-screenshots")
      .getPublicUrl(fileName);

    return {
      captured: true,
      viewport: "1920x1080",
      imageUrl: data.publicUrl,
      notes: "Full-page 1920px desktop screenshot captured after lazy-load scroll and uploaded successfully."
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
Act as a Senior Website QA Content Auditor.

Perform STRICT website QA.

Compare:
1. source DOCX/PDF files,
2. optional Elementor JSON files,
3. optional design PDF/XD files,
4. live website URLs.

Rules:
- Live URLs are compulsory.
- DOC/PDF is primary source of truth if uploaded.
- JSON supports structure only.
- Ignore styling differences.
- Focus on missing content, duplicated content, extra content, modified wording, placement/order issues, wrong city, wrong phone, wrong FAQ, and wrong CTA.
- If no source file is provided, do not pretend a full source comparison was completed.
- Return ONLY valid JSON.

Structure:
{
  "overallResult": "PASS or FAIL",
  "pages": [
    {
      "page": "URL",
      "sourceFile": "matched file or Not provided",
      "jsonFile": "matched json or Optional / Not provided",
      "result": "PASS or FAIL",
      "mainIssue": "summary",
      "sections": [],
      "missingContent": [],
      "duplicatedContent": [],
      "extraContent": [],
      "modifiedContent": [],
      "placementIssues": [],
      "whatToChange": []
    }
  ]
}

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
            content: "You are a strict senior website QA content auditor. Return only valid JSON."
          },
          {
            role: "user",
            content: prompt
          }
        ],
        temperature: 0.1
      });

      const output = completion.choices[0].message.content;
      const clean = output.replace(/```json|```/g, "").trim();
      const json = JSON.parse(clean);

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
