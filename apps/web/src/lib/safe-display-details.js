const HIDDEN_TECHNICAL_DETAIL_COPY =
  "CareerRat hides raw technical details here because they can include private information.";

export function safeDisplayDetail(value) {
  return typeof value === "string" && value.trim() ? HIDDEN_TECHNICAL_DETAIL_COPY : null;
}
