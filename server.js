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

const RUNTIME_QA_PROMPT = `
You are Vayu Sentinel, a strict forensic website content QA auditor.

INPUT RULES:
- Live URL is required.
- DOCX/PDF source is optional, but if uploaded it is PRIMARY source truth.
- Design PDF/XD is fallback source truth if DOCX/PDF is unavailable.
- JSON is optional support only.
- Do not fail because JSON/design is missing.
- If no source/design is uploaded, fail with clear reason.

QA PRIORITY:
1. Compare source DOCX/PDF or design content to live page.
2. Use structured live chunks: meta, hero, headings, sections, CTAs, benefits, steps, FAQs, reviews.
3. Use deterministic mismatch hints as mandatory evidence to verify.
4. Do not compare page-body DOC against header/footer/nav unless source/design/JSON clearly includes global components.

STRICT CHECKS:
- Meta title and description
- Hero heading/subheading
- CTAs
- Intro/body paragraphs
- Section headings
- Benefits/cards
- Process/numbered steps
- Reviews and author attribution
- FAQs question and answer
- Brand/practice name
- City/location
- Phone/email/address
- Missing, extra, duplicated, modified, misplaced content

IMPORTANT:
- Do not summarize issues broadly.
- Every real mismatch must be itemized.
- Include source wording and live wording where possible.
- CTA mismatch, FAQ mismatch, review author mismatch, benefit mismatch, process step mismatch must be explicitly listed if present.
- Extra non-conflicting reviews/education/CTA content should be INFO/LOW, not FAIL reason.
- Wrong city, brand, phone, treatment, CTA intent, FAQ meaning, review author = HIGH severity.
- Minor punctuation/capitalization = LOW.

OUTPUT:
Return ONLY valid JSON.
No markdown.
No text before or after JSON.
First character must be { and last character must be }.

JSON structure:
{
  "overallResult": "PASS or FAIL",
  "pages": [
    {
      "page": "URL",
      "sourceFile": "matched source file or Not provided",
      "jsonFile": "matched json file or Optional / Not provided",
      "result": "PASS or FAIL",
      "mainIssue": "short manager-ready summary",
      "sections": [
        {
          "section": "section name",
          "severity": "HIGH / MEDIUM / LOW / INFO",
          "jsonStatus": "Found / Missing / Optional / Not provided",
          "liveStatus": "Matched / Missing / Modified / Extra / Could not access",
          "result": "PASS or FAIL",
          "notes": "specific evidence with source vs live wording"
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
`;

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

function normalizeForCompare(value) {
  return cleanOneLine(value)
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function softContains(haystack, needle) {
  const h = normalizeForCompare(haystack);
  const n = normalizeForCompare(needle);

  if (!n || n.length < 4) return true;

  return h.includes(n);
}

function extractTextList($, selector, maxItems = 35, maxLength = 220) {
  const values = [];

  $(selector).each((_, el) => {
    const text = cleanOneLine($(el).text());

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
      cleanOneLine(node.text()) ||
      cleanOneLine(node.attr("value")) ||
      cleanOneLine(node.attr("aria-label"));

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
      text: limitText(text, 120),
      href,
      tag: el.tagName || ""
    });
  });

  const seen = new Set();

  return ctas
    .filter(cta => {
      const key = `${cta.text}|${cta.href}`.toLowerCase();

      if (seen.has(key)) return false;

      seen.add(key);

      return true;
    })
    .slice(0, 15);
}

function extractFaqsFromHtml($) {
  const faqs = [];

  $("details").each((_, el) => {
    const question = cleanOneLine($(el).find("summary").first().text());
    const answer = cleanOneLine($(el).text()).replace(question, "").trim();

    if (question || answer) {
      faqs.push({
        question: limitText(question, 180),
        answer: limitText(answer, 420),
        source: "details"
      });
    }
  });

  $(".elementor-accordion-item, .elementor-toggle-item, .accordion-item, .faq-item, [class*='faq'], [class*='accordion']").each((_, el) => {
    const item = $(el);

    const question =
      cleanOneLine(item.find(".elementor-tab-title").first().text()) ||
      cleanOneLine(item.find(".accordion-title").first().text()) ||
      cleanOneLine(item.find(".faq-question").first().text()) ||
      cleanOneLine(item.find("h2,h3,h4,button").first().text());

    let answer =
      cleanOneLine(item.find(".elementor-tab-content").first().text()) ||
      cleanOneLine(item.find(".accordion-content").first().text()) ||
      cleanOneLine(item.find(".faq-answer").first().text());

    if (!answer) {
      const allText = cleanOneLine(item.text());

      if (question && allText.includes(question)) {
        answer = cleanOneLine(allText.replace(question, ""));
      } else {
        answer = allText;
      }
    }

    if ((question && question.length > 3) || answer.length > 20) {
      faqs.push({
        question: limitText(question, 180),
        answer: limitText(answer, 420),
        source: "accordion/faq"
      });
    }
  });

  const seen = new Set();

  return faqs
    .filter(faq => {
      const key = `${faq.question}|${faq.answer}`.toLowerCase();

      if (!faq.question && !faq.answer) return false;
      if (seen.has(key)) return false;

      seen.add(key);

      return true;
    })
    .slice(0, 10);
}

function extractReviewsFromHtml($) {
  const reviews = [];

  $(".review, .testimonial, .swiper-slide, [class*='review'], [class*='testimonial'], [class*='rating']").each((_, el) => {
    const item = $(el);
    const text = cleanOneLine(item.text());

    if (text.length < 20) return;

    const author =
      cleanOneLine(item.find(".author,.name,.reviewer,[class*='author'],[class*='name']").first().text()) ||
      "";

    reviews.push({
      author: limitText(author, 90),
      text: limitText(text, 450)
    });
  });

  const seen = new Set();

  return reviews
    .filter(review => {
      const key = review.text.toLowerCase();

      if (seen.has(key)) return false;

      seen.add(key);

      return true;
    })
    .slice(0, 6);
}

function extractBenefitCards($) {
  const cards = [];

  $(".elementor-icon-box-wrapper, .elementor-widget-icon-box, .card, .benefit, [class*='benefit'], [class*='icon-box']").each((_, el) => {
    const item = $(el);

    const title =
      cleanOneLine(item.find(".elementor-icon-box-title").first().text()) ||
      cleanOneLine(item.find("h2,h3,h4,strong").first().text());

    const description =
      cleanOneLine(item.find(".elementor-icon-box-description").first().text()) ||
      cleanOneLine(item.find("p").first().text());

    const fullText = cleanOneLine(item.text());

    if (fullText.length < 5 || fullText.length > 700) return;

    cards.push({
      title: limitText(title, 120),
      description: limitText(description, 250),
      text: limitText(fullText, 350)
    });
  });

  const seen = new Set();

  return cards
    .filter(card => {
      const key = card.text.toLowerCase();

      if (seen.has(key)) return false;

      seen.add(key);

      return true;
    })
    .slice(0, 10);
}

function extractProcessStepsFromHtml($) {
  const steps = [];

  $("ol li").each((index, el) => {
    const text = cleanOneLine($(el).text());

    if (text.length > 5) {
      steps.push({
        number: index + 1,
        text: limitText(text, 420),
        source: "ordered-list"
      });
    }
  });

  $(".elementor-accordion-item, .accordion-item, .step, [class*='step'], [class*='process']").each((index, el) => {
    const text = cleanOneLine($(el).text());

    if (text.length > 10 && text.length < 1400) {
      steps.push({
        number: index + 1,
        text: limitText(text, 420),
        source: "accordion/process"
      });
    }
  });

  const seen = new Set();

  return steps
    .filter(step => {
      const key = step.text.toLowerCase();

      if (seen.has(key)) return false;

      seen.add(key);

      return true;
    })
    .slice(0, 8);
}

function extractSections($) {
  const sections = [];

  $("h1, h2, h3").each((_, el) => {
    const headingNode = $(el);

    const heading = cleanOneLine(headingNode.text());
    const level = String(el.tagName || "").toUpperCase();

    if (!heading || heading.length < 2) return;

    let sectionText = "";

    const closestSection = headingNode.closest("section");

    if (closestSection.length) {
      sectionText = cleanOneLine(closestSection.text());
    }

    if (!sectionText || sectionText.length < heading.length + 20) {
      const parent = headingNode.parent();
      sectionText = cleanOneLine(parent.text());
    }

    sections.push({
      heading,
      level,
      text: limitText(sectionText, 500)
    });
  });

  const seen = new Set();

  return sections
    .filter(section => {
      const key = `${section.level}|${section.heading}|${section.text.slice(0, 100)}`.toLowerCase();

      if (seen.has(key)) return false;

      seen.add(key);

      return true;
    })
    .slice(0, 10);
}

function extractContactDetails($, fullText) {
  const phoneMatches =
    fullText.match(/(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g) || [];

  const emailMatches =
    fullText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];

  return {
    phones: uniqueStrings(phoneMatches),
    emails: uniqueStrings(emailMatches)
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

    const h1 = extractTextList($, "h1", 10, 220);
    const h2 = extractTextList($, "h2", 30, 220);
    const h3 = extractTextList($, "h3", 30, 220);

    const headings = uniqueStrings([...h1, ...h2, ...h3]);

    const pageClone = $("body").clone();

    pageClone.find("header, nav, footer, script, style, noscript, svg, iframe").remove();

    let mainContent = "";

    if ($("main").length) {
      mainContent = cleanOneLine($("main").text());
    } else {
      mainContent = cleanOneLine(pageClone.text());
    }

    const fullBodyText = cleanOneLine($("body").text());

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
        all: headings.slice(0, 35)
      },

      sections: extractSections($),

      ctas: extractCtas($),

      benefits: extractBenefitCards($),

      processSteps: extractProcessStepsFromHtml($),

      faqs: extractFaqsFromHtml($),

      reviews: extractReviewsFromHtml($),

      contactDetails: extractContactDetails($, fullBodyText),

      globalComponents: {
        headerText: limitText(headerText, 500),
        navText: limitText(navText, 500),
        footerText: limitText(footerText, 700)
      },

      pageBody: {
        mainContent: limitText(mainContent, 2500)
      }
    };

    return {
      url,
      title,
      metaDescription,
      heroHeading,
      heroSubheading,
      headings: headings.slice(0, 35),
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
      headings: [],
      structuredContent: {}
    };
  }
}

function extractMetaFromSource(text) {
  const compact = cleanText(text);

  const metaTitleMatch =
    compact.match(/Meta Title\s+([\s\S]*?)(?=\nMeta Description|\nH1:|\nH2:|\nREQUEST|\nWhat is|$)/i);

  const metaDescriptionMatch =
    compact.match(/Meta Description\s+([\s\S]*?)(?=\nH1:|\nH2:|\nREQUEST|\nWhat is|$)/i);

  return {
    metaTitle: metaTitleMatch ? cleanOneLine(metaTitleMatch[1]) : "",
    metaDescription: metaDescriptionMatch ? cleanOneLine(metaDescriptionMatch[1]) : ""
  };
}

function extractSourceCtas(text) {
  const lines = cleanText(text)
    .split("\n")
    .map(cleanOneLine)
    .filter(Boolean);

  const ctas = [];

  lines.forEach(line => {
    const lower = line.toLowerCase();

    const isCta =
      lower.includes("book") ||
      lower.includes("appointment") ||
      lower.includes("request") ||
      lower.includes("schedule") ||
      lower.includes("contact") ||
      lower.includes("call today") ||
      lower.includes("ready to get started");

    if (isCta && line.length <= 160) {
      ctas.push(line);
    }
  });

  return uniqueStrings(ctas).slice(0, 10);
}

function extractSourceHeadings(text) {
  const lines = cleanText(text)
    .split("\n")
    .map(cleanOneLine)
    .filter(Boolean);

  const headingPatterns = [
    /^H[1-6]:/i,
    /^What is /i,
    /^Why /i,
    /^Who /i,
    /^What to expect/i,
    /^Oral health/i,
    /^At-home care/i,
    /^About /i,
    /^Real patient reviews/i,
    /^Ready to get started/i,
    /^FAQs/i,
    /^\d+\.\s*[A-Z]/,
    /^4 benefits/i
  ];

  return uniqueStrings(
    lines.filter(line => headingPatterns.some(pattern => pattern.test(line)))
  ).slice(0, 25);
}

function extractSourceBenefits(text) {
  const lines = cleanText(text)
    .split("\n")
    .map(cleanOneLine)
    .filter(Boolean);

  const benefits = [];

  lines.forEach(line => {
    if (
      line.startsWith("•") ||
      /^(Relief|Function|Comfort|Protection)\b/i.test(line)
    ) {
      benefits.push(line.replace(/^•\s*/, ""));
    }
  });

  return uniqueStrings(benefits).slice(0, 12);
}

function extractSourceSteps(text) {
  const lines = cleanText(text)
    .split("\n")
    .map(cleanOneLine)
    .filter(Boolean);

  const steps = [];

  lines.forEach(line => {
    const match = line.match(/^(\d+)\.\s*(.*)/);

    if (match) {
      steps.push({
        number: Number(match[1]),
        text: limitText(match[2], 500)
      });
    }
  });

  return steps.slice(0, 12);
}

function extractSourceFaqs(text) {
  const lines = cleanText(text)
    .split("\n")
    .map(cleanOneLine)
    .filter(Boolean);

  const faqs = [];

  const startIndex = lines.findIndex(line =>
    /^FAQs/i.test(line)
  );

  if (startIndex === -1) return [];

  let currentQuestion = "";
  let currentAnswer = "";

  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i];

    if (!line) continue;

    const isQuestion = line.endsWith("?");

    if (isQuestion) {
      if (currentQuestion || currentAnswer) {
        faqs.push({
          question: currentQuestion,
          answer: limitText(currentAnswer, 500)
        });
      }

      currentQuestion = line;
      currentAnswer = "";
    } else {
      currentAnswer += " " + line;
    }
  }

  if (currentQuestion || currentAnswer) {
    faqs.push({
      question: currentQuestion,
      answer: limitText(currentAnswer, 500)
    });
  }

  return faqs.slice(0, 10);
}

function extractSourceReviews(text) {
  const normalized = cleanText(text);
  const reviews = [];

  const quoteRegex = /[“"]([^”"]{30,1600})[”"]\s*[–-]\s*([A-Za-z][A-Za-z.\s]{1,60})/g;

  let match;

  while ((match = quoteRegex.exec(normalized)) !== null) {
    reviews.push({
      quote: limitText(match[1], 500),
      author: cleanOneLine(match[2])
    });
  }

  return reviews.slice(0, 10);
}

function extractSourceSections(text) {
  const lines = cleanText(text)
    .split("\n")
    .map(cleanOneLine)
    .filter(Boolean);

  const headings = extractSourceHeadings(text);
  const sections = [];

  headings.forEach((heading, index) => {
    const startIndex = lines.findIndex(line => line === heading);

    if (startIndex === -1) return;

    const nextHeading = headings[index + 1];

    let endIndex = lines.length;

    if (nextHeading) {
      const possibleEnd = lines.findIndex((line, i) => i > startIndex && line === nextHeading);

      if (possibleEnd !== -1) {
        endIndex = possibleEnd;
      }
    }

    sections.push({
      heading,
      text: limitText(lines.slice(startIndex, endIndex).join(" "), 700)
    });
  });

  return sections.slice(0, 12);
}

function extractSourceStructuredContent(file) {
  const text = cleanText(file.text || "");
  const meta = extractMetaFromSource(text);

  return {
    fileName: file.fileName,
    meta,
    headings: extractSourceHeadings(text),
    ctas: extractSourceCtas(text),
    benefits: extractSourceBenefits(text),
    processSteps: extractSourceSteps(text),
    faqs: extractSourceFaqs(text),
    reviews: extractSourceReviews(text),
    sections: extractSourceSections(text),
    fullText: limitText(text, 3500)
  };
}

function buildDeterministicHints(sourceStruct, livePageCompact) {
  const hints = [];

  const live = livePageCompact.structuredContent || {};
  const liveText = JSON.stringify(livePageCompact).toLowerCase();

  if (sourceStruct.meta?.metaTitle) {
    const sourceTitle = sourceStruct.meta.metaTitle;
    const liveTitle = live.meta?.metaTitle || livePageCompact.title || "";

    if (normalizeForCompare(sourceTitle) !== normalizeForCompare(liveTitle)) {
      hints.push({
        type: "META_TITLE_MISMATCH",
        severity: "HIGH",
        source: sourceTitle,
        live: liveTitle
      });
    }
  }

  if (sourceStruct.meta?.metaDescription) {
    const sourceDescription = sourceStruct.meta.metaDescription;
    const liveDescription = live.meta?.metaDescription || livePageCompact.metaDescription || "";

    if (!softContains(liveDescription, sourceDescription)) {
      hints.push({
        type: "META_DESCRIPTION_MISMATCH",
        severity: "MEDIUM",
        source: sourceDescription,
        live: liveDescription || "not detected"
      });
    }
  }

  sourceStruct.ctas.forEach(sourceCta => {
    const liveCtas = live.ctas || [];

    const matched = liveCtas.some(cta =>
      normalizeForCompare(cta.text) === normalizeForCompare(sourceCta)
    );

    if (!matched) {
      hints.push({
        type: "CTA_MISMATCH_OR_MISSING",
        severity: "HIGH",
        source: sourceCta,
        live: liveCtas.map(cta => cta.text).join(" | ") || "no live CTA detected"
      });
    }
  });

  sourceStruct.benefits.forEach(sourceBenefit => {
    if (!softContains(liveText, sourceBenefit)) {
      hints.push({
        type: "BENEFIT_TEXT_MISSING_OR_MODIFIED",
        severity: "HIGH",
        source: sourceBenefit,
        live: "No exact matching live benefit text found"
      });
    }
  });

  sourceStruct.processSteps.forEach(sourceStep => {
    if (!softContains(liveText, sourceStep.text)) {
      hints.push({
        type: "PROCESS_STEP_MISMATCH",
        severity: "MEDIUM",
        source: `Step ${sourceStep.number}: ${sourceStep.text}`,
        live: "No exact matching live process step found"
      });
    }
  });

  sourceStruct.faqs.forEach(sourceFaq => {
    const liveFaqs = live.faqs || [];

    const matchingQuestion = liveFaqs.find(faq =>
      normalizeForCompare(faq.question) === normalizeForCompare(sourceFaq.question)
    );

    if (!matchingQuestion) {
      hints.push({
        type: "FAQ_QUESTION_MISSING_OR_CHANGED",
        severity: "HIGH",
        source: sourceFaq.question,
        live: liveFaqs.map(faq => faq.question).join(" | ") || "no live FAQ question detected"
      });

      return;
    }

    if (!softContains(matchingQuestion.answer, sourceFaq.answer)) {
      hints.push({
        type: "FAQ_ANSWER_MISMATCH",
        severity: "HIGH",
        source: `Q: ${sourceFaq.question} | A: ${sourceFaq.answer}`,
        live: `Q: ${matchingQuestion.question} | A: ${matchingQuestion.answer}`
      });
    }
  });

  sourceStruct.reviews.forEach(sourceReview => {
    if (!softContains(liveText, sourceReview.author)) {
      hints.push({
        type: "REVIEW_AUTHOR_MISSING_OR_CHANGED",
        severity: "HIGH",
        source: sourceReview.author,
        live: "No exact matching live review author found"
      });
    }

    if (!softContains(liveText, sourceReview.quote)) {
      hints.push({
        type: "REVIEW_QUOTE_MISSING_OR_MODIFIED",
        severity: "MEDIUM",
        source: sourceReview.quote,
        live: "No exact matching live review quote found"
      });
    }
  });

  return hints.slice(0, 35);
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

function compactFileText(file, maxChars = 3500) {
  return {
    fileName: file.fileName,
    text: limitText(file.text, maxChars)
  };
}

function compactLivePageForAi(page) {
  const structured = page.structuredContent || {};

  return {
    url: page.url,
    title: page.title,
    metaDescription: page.metaDescription,
    heroHeading: page.heroHeading,
    heroSubheading: page.heroSubheading,
    headings: (page.headings || []).slice(0, 25),

    structuredContent: {
      meta: structured.meta || {},

      hero: structured.hero || {},

      headingHierarchy: {
        h1: structured.headingHierarchy?.h1 || [],
        h2: (structured.headingHierarchy?.h2 || []).slice(0, 20),
        h3: (structured.headingHierarchy?.h3 || []).slice(0, 20),
        all: (structured.headingHierarchy?.all || []).slice(0, 28)
      },

      sections: (structured.sections || []).slice(0, 8).map(section => ({
        heading: section.heading,
        level: section.level,
        text: limitText(section.text, 420)
      })),

      ctas: (structured.ctas || []).slice(0, 12),

      benefits: (structured.benefits || []).slice(0, 10),

      processSteps: (structured.processSteps || []).slice(0, 8),

      faqs: (structured.faqs || []).slice(0, 8).map(faq => ({
        question: limitText(faq.question, 160),
        answer: limitText(faq.answer, 300),
        source: faq.source
      })),

      reviews: (structured.reviews || []).slice(0, 5).map(review => ({
        author: review.author,
        text: limitText(review.text, 350)
      })),

      contactDetails: structured.contactDetails || {},

      globalComponents: {
        headerText: limitText(structured.globalComponents?.headerText || "", 300),
        navText: limitText(structured.globalComponents?.navText || "", 300),
        footerText: limitText(structured.globalComponents?.footerText || "", 400)
      },

      pageBody: {
        mainContent: limitText(structured.pageBody?.mainContent || "", 1800)
      }
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

function buildDeterministicFallbackReport({
  url,
  sourceFile,
  screenshotResult,
  hints
}) {
  const highOrMedium = hints.filter(hint =>
    ["HIGH", "MEDIUM"].includes(hint.severity)
  );

  return {
    page: url,
    sourceFile: sourceFile?.fileName || "Not provided",
    jsonFile: "Optional / Not provided",
    result: highOrMedium.length ? "FAIL" : "PASS",
    mainIssue: highOrMedium.length
      ? "Source and live page have content mismatches"
      : "No high-priority deterministic mismatches found",
    sections: hints.slice(0, 12).map(hint => ({
      section: hint.type,
      severity: hint.severity,
      jsonStatus: "Optional / Not provided",
      liveStatus: "Modified",
      result: ["HIGH", "MEDIUM"].includes(hint.severity) ? "FAIL" : "PASS",
      notes: `Source: '${hint.source}' | Live: '${hint.live}'`
    })),
    missingContent: hints
      .filter(hint => hint.type.includes("MISSING"))
      .map(hint => `Source: '${hint.source}' | Live: '${hint.live}'`),
    duplicatedContent: [],
    extraContent: [],
    modifiedContent: hints
      .filter(hint =>
        hint.type.includes("MISMATCH") ||
        hint.type.includes("MODIFIED") ||
        hint.type.includes("CHANGED")
      )
      .map(hint => `Source: '${hint.source}' | Live: '${hint.live}' | Type: ${hint.type}`),
    placementIssues: [],
    whatToChange: highOrMedium.map(hint =>
      `Fix ${hint.type}: source '${hint.source}' should match live content.`
    ),
    screenshotQA: screenshotResult
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

  const sourceStructured = relevantSourceFiles.map(file =>
    extractSourceStructuredContent(file)
  );

  const liveCompact = compactLivePageForAi(livePage);

  const deterministicHints = sourceStructured.flatMap(source =>
    buildDeterministicHints(source, liveCompact)
  );

  const fallbackReport = buildDeterministicFallbackReport({
    url,
    sourceFile: relevantSourceFiles[0] || relevantDesignFiles[0],
    screenshotResult,
    hints: deterministicHints
  });

  const prompt = `
${RUNTIME_QA_PROMPT}

MANDATORY BACKEND MISMATCH HINTS:
You MUST include valid hints in the final report.
If you exclude a hint, only exclude it if clearly false.

${JSON.stringify(deterministicHints.slice(0, 30), null, 2)}

AUDIT ONLY THIS ONE PAGE:
${url}

LIVE PAGE COMPACT STRUCTURED DATA:
${JSON.stringify(liveCompact, null, 2)}

MATCHED SOURCE STRUCTURED CONTENT:
${JSON.stringify(sourceStructured.map(source => ({
    fileName: source.fileName,
    meta: source.meta,
    headings: source.headings.slice(0, 18),
    ctas: source.ctas.slice(0, 8),
    benefits: source.benefits.slice(0, 8),
    processSteps: source.processSteps.slice(0, 7),
    faqs: source.faqs.slice(0, 7),
    reviews: source.reviews.slice(0, 5),
    sections: source.sections.slice(0, 8),
    fullText: limitText(source.fullText, 2000)
  })), null, 2)}

MATCHED JSON SUPPORT:
${JSON.stringify(relevantJsonFiles.map(file => compactFileText(file, 1200)), null, 2)}

MATCHED DESIGN SUPPORT:
${JSON.stringify(relevantDesignFiles.map(file => compactFileText(file, 1500)), null, 2)}
`;

  try {
    const completion = await groq.chat.completions.create({
      model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
      messages: [
        {
          role: "system",
          content: "Return only valid compact JSON. No markdown. No explanation outside JSON."
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
      pageReport = fallbackReport;
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
  } catch (error) {
    console.error("AI page audit failed, using deterministic fallback:", error.message);

    return fallbackReport;
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
