import express from "express";
import cors from "cors";
import multer from "multer";
import dotenv from "dotenv";
import axios from "axios";
import * as cheerio from "cheerio";
import mammoth from "mammoth";
import pdfParse from "pdf-parse";
import Groq from "groq-sdk";

dotenv.config();

const app = express();

const upload = multer({
  storage: multer.memoryStorage()
});

app.use(cors());

app.use(express.json({
  limit: "50mb"
}));

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

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

    const h1 = $("h1")
      .map((_, el) => $(el).text().trim())
      .get();

    const h2 = $("h2")
      .map((_, el) => $(el).text().trim())
      .get();

    const bodyText = $("body")
      .text()
      .replace(/\s+/g, " ")
      .trim();

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

```js
async function capturePageScreenshot(url) {

  try {

    const screenshotUrl =
      "https://production-sfo.browserless.io/screenshot?token=YOUR_BROWSERLESS_TOKEN";

    const response = await axios.post(
      screenshotUrl,
      {
        url,
        options: {
          fullPage: true,
          type: "png"
        }
      },
      {
        responseType: "arraybuffer"
      }
    );

    return {
      captured: true,
      viewport: "1440x1200",
      imageBase64: Buffer.from(response.data).toString("base64"),
      notes: "Full-page screenshot captured successfully."
    };

  } catch (error) {

    return {
      captured: false,
      viewport: "1440x1200",
      imageBase64: "",
      notes: `Screenshot capture failed: ${error.message}`
    };
  }
}

app.post(
  "/api/run-qa-audit",

  upload.fields([
    {
      name: "contentFiles",
      maxCount: 30
    },
    {
      name: "jsonFiles",
      maxCount: 30
    },
    {
      name: "designFiles",
      maxCount: 30
    }
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

      const livePages = await Promise.all(
        urls.map(extractLivePageText)
      );

      const screenshotResults = await Promise.all(
        urls.map(url => capturePageScreenshot(url))
      );

      const sourceTexts = await Promise.all(
        contentFiles.map(extractFileText)
      );

      const jsonTexts = await Promise.all(
        jsonFiles.map(extractFileText)
      );

      const designTexts = await Promise.all(
        designFiles.map(extractFileText)
      );

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
- Focus on:
  - missing content
  - duplicated content
  - extra content
  - modified wording
  - placement/order issues
  - wrong city
  - wrong phone
  - wrong FAQ
  - wrong CTA

Return ONLY valid JSON.

Structure:

{
  "overallResult": "PASS or FAIL",
  "pages": [
    {
      "page": "URL",
      "sourceFile": "matched file",
      "jsonFile": "matched json",
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

        model:
          process.env.GROQ_MODEL ||
          "llama-3.3-70b-versatile",

        messages: [
          {
            role: "system",
            content:
              "You are a strict senior website QA content auditor. Return only valid JSON."
          },
          {
            role: "user",
            content: prompt
          }
        ],

        temperature: 0.1
      });

      const output =
        completion.choices[0].message.content;

      const clean = output
        .replace(/```json|```/g, "")
        .trim();

      const json = JSON.parse(clean);

      if (Array.isArray(json.pages)) {

        json.pages = json.pages.map((page, index) => ({
          ...page,

          screenshotQA:
            screenshotResults[index] || {
              captured: false,
              viewport: "1440x1200",
              imageBase64: "",
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
  console.log(
    `QA Audit Backend running on port ${PORT}`
  );
});
