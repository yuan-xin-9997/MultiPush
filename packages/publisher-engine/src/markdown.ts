import { Marked } from "marked";
import sanitizeHtml from "sanitize-html";

const parser = new Marked({ gfm: true, breaks: true });
export function renderMarkdown(source: string) {
  const tokens = parser.lexer(source);
  parser.walkTokens(tokens, (token) => {
    if (token.type === "image")
      throw new Error(
        "Markdown内嵌图片暂不支持，请在正文图片列表添加本地图片（按顺序追加文末）",
      );
    if (token.type === "html")
      throw new Error("Markdown暂不接受原始HTML，请使用Markdown语法");
  });
  return sanitizeHtml(parser.parser(tokens), {
    allowedTags: [
      "p",
      "br",
      "h1",
      "h2",
      "h3",
      "h4",
      "h5",
      "h6",
      "strong",
      "em",
      "del",
      "blockquote",
      "ul",
      "ol",
      "li",
      "pre",
      "code",
      "hr",
      "table",
      "thead",
      "tbody",
      "tr",
      "th",
      "td",
      "a",
    ],
    allowedAttributes: { a: ["href", "title"] },
    allowedSchemes: ["https", "http"],
    allowProtocolRelative: false,
  });
}
