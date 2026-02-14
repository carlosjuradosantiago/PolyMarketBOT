/**
 * Auto-translate Polymarket market questions from English to Spanish.
 * Uses pattern-based rules for common market question formats.
 */

// Common word/phrase translations
const WORD_MAP: [RegExp, string][] = [
  // Question starters
  [/\bWill\b/gi, "¿"],
  [/\bclose above\b/gi, "cerrará por encima de"],
  [/\bclose below\b/gi, "cerrará por debajo de"],
  [/\bclose between\b/gi, "cerrará entre"],
  [/\bUp or Down\b/gi, "¿Sube o Baja"],
  [/\bgo up or down\b/gi, "subirá o bajará"],
  [/\bread above\b/gi, "llegará por encima de"],
  [/\breach\b/gi, "llegará a"],
  [/\bfall below\b/gi, "caerá por debajo de"],
  [/\brise above\b/gi, "subirá por encima de"],
  [/\bdrop below\b/gi, "caerá por debajo de"],
  [/\bend in a draw\b/gi, "terminará en empate"],
  [/\bBoth Teams to Score\b/gi, "Ambos Equipos Anotan"],
  [/\bOver (\d+\.?\d*) goals\b/gi, "Más de $1 goles"],
  [/\bUnder (\d+\.?\d*) goals\b/gi, "Menos de $1 goles"],
  [/\bto win\b/gi, "ganará"],
  [/\bto beat\b/gi, "le ganará a"],
  [/\bwin the\b/gi, "ganará el/la"],
  [/\bWho will win\b/gi, "¿Quién ganará"],
  
  // Time / date
  [/\bon February\b/gi, "el 12 de febrero"],
  [/\bon March\b/gi, "en marzo"],
  [/\bon January\b/gi, "en enero"],
  [/\bby end of day\b/gi, "al cierre del día"],
  [/\btoday\b/gi, "hoy"],
  [/\btomorrow\b/gi, "mañana"],
  [/\bthis week\b/gi, "esta semana"],
  
  // Finance
  [/\bprice\b/gi, "precio"],
  [/\bstock\b/gi, "acción"],
  [/\bmarket cap\b/gi, "capitalización"],
  [/\btrading volume\b/gi, "volumen de trading"],
  
  // Outcomes
  [/\bYes\b/g, "Sí"],
  [/\bNo\b/g, "No"],
  [/\bUp\b/g, "Sube"],
  [/\bDown\b/g, "Baja"],
  
  // Sport terms
  [/\bvs\.?\b/gi, "vs"],
  [/\bdraw\b/gi, "empate"],
  [/\bgoals\b/gi, "goles"],
  [/\bhalf-time\b/gi, "medio tiempo"],
  [/\bfull-time\b/gi, "tiempo completo"],
  
  // Common endings
  [/\?$/g, "?"],
];

// Date pattern: "on February 12" → "el 12 de febrero"
const MONTHS: Record<string, string> = {
  January: "enero", February: "febrero", March: "marzo", April: "abril",
  May: "mayo", June: "junio", July: "julio", August: "agosto",
  September: "septiembre", October: "octubre", November: "noviembre", December: "diciembre",
};

function translateDatePattern(text: string): string {
  // "on February 12" → "el 12 de febrero"
  return text.replace(/\bon (\w+) (\d{1,2})\b/gi, (_, month, day) => {
    const mes = MONTHS[month] || month;
    return `el ${day} de ${mes}`;
  });
}

// Cache to avoid re-translating
const cache = new Map<string, string>();

export function translateMarketQuestion(question: string): string {
  if (!question) return question;
  
  const cached = cache.get(question);
  if (cached) return cached;
  
  let result = question;
  
  // First, handle date patterns
  result = translateDatePattern(result);
  
  // Apply word map rules
  for (const [pattern, replacement] of WORD_MAP) {
    result = result.replace(pattern, replacement);
  }
  
  // Clean up: if starts with "¿" ensure it ends with "?"
  if (result.startsWith("¿") && !result.endsWith("?")) {
    result += "?";
  }
  
  // Clean up double question marks
  result = result.replace(/\?\?/g, "?");
  
  // If translation didn't change much, keep original
  // (means it's a format we don't handle)
  
  cache.set(question, result);
  return result;
}

/**
 * Translate an outcome name
 */
export function translateOutcome(outcome: string): string {
  switch (outcome.toLowerCase()) {
    case "yes": return "Sí";
    case "no": return "No";
    case "up": return "Sube";
    case "down": return "Baja";
    case "draw": return "Empate";
    default: return outcome;
  }
}
