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
const upload = multer({ storage: multer.memoryStorage() });

app.use(cors());
app.use(express.json({ limit: "50mb" }));

const groq = new Groq({
  apiKey: process.env.GROQ_API_KEY
});

app.get("/", (req, res) => {
  res.json({ status: "QA Audit Backend is running" });
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
      return { fileName: name, text: result.value || "" };
    }

    if (lower.endsWith(".pdf")) {
      const result = await pdfParse(file.buffer);
      return { fileName: name, text: result.text || "" };
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
        return res.status(400).json({ error: "At least one live URL is required." });
      }

      const contentFiles = req.files?.contentFiles || [];
      const jsonFiles = req.files?.jsonFiles || [];
      const designFiles = req.files?.designFiles || [];

      const livePages = await Promise.all(urls.map(extractLivePageText));

      const sourceTexts = await Promise.all(contentFiles.map(extractFileText));
      const jsonTexts = await Promise.all(jsonFiles.map(extractFileText));
      const designTexts = await Promise.all(designFiles.map(extractFileText));

      const prompt = `
Act as a Senior Website QA Content Auditor.

Perform STRICT content QA by comparing:
1. source DOCX/PDF files,
2. optional Elementor JSON files,
3. optional design PDF/XD files,
4. live website page URLs.

Rules:
- Live URLs are compulsory.
- Content DOC/PDF files are optional, but if uploaded, they are the primary source of truth.
- Design PDF/XD files are optional fallback source truth if content DOC/PDF is unavailable.
- Elementor JSON files are optional support files only.
- Do NOT fail heading tag or styling differences.
- Focus on user-facing content accuracy, presence, placement, sequence, and correctness.
- Identify missing content, extra content, duplicated content, modified wording, wrong brand, wrong city/location, wrong phone number, wrong FAQ, and section order issues.
- Be strict but fair.
- Do not invent issues.

Return ONLY valid JSON in this exact structure:

{
  "overallResult": "PASS or FAIL",
  "pages": [
    {
      "page": "URL",
      "sourceFile": "matched source file or Not provided",
      "jsonFile": "matched json file or Optional / Not provided",
      "result": "PASS or FAIL",
      "mainIssue": "short summary",
      "sections": [
        {
          "section": "section name",
          "jsonStatus": "Found / Missing / Optional / Not provided",
          "liveStatus": "Matched / Missing / Modified / Extra / Could not access",
          "result": "PASS or FAIL",
          "notes": "specific evidence"
        }
      ],
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

SOURCE DOC/PDF FILE TEXT:
${JSON.stringify(sourceTexts, null, 2)}

ELEMENTOR JSON TEXT:
${JSON.stringify(jsonTexts, null, 2)}

DESIGN FILE TEXT:
${JSON.stringify(designTexts, null, 2)}
`;

      const completion = await openai.chat.completions.create({
        model: process.env.OPENAI_MODEL || "gpt-4.1",
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
