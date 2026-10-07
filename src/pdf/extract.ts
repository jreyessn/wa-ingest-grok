import { PDFParse } from "pdf-parse";

export async function extractPdfText(data: Buffer): Promise<string> {
  const parser = new PDFParse({ data });
  try {
    const result = await parser.getText();
    const pages = result.pages
      .map((page) => page.text.trim())
      .filter((text) => text.length > 0);
    if (pages.length > 0) return pages.join("\n\n");
    return typeof result.text === "string" ? result.text.trim() : "";
  } finally {
    await parser.destroy();
  }
}
