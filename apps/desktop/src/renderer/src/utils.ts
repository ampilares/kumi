export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

/** Page title fallback used everywhere Notion shows "Untitled". */
export function displayTitle(title: string | null | undefined): string {
  const t = (title ?? "").trim();
  return t.length > 0 ? t : "Untitled";
}

export function formatDate(ts: number): string {
  try {
    return new Date(ts).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return "";
  }
}

/** Collapse middle breadcrumb segments to "…" when there are more than `max`. */
export function collapseCrumbs<T>(items: T[], max = 3): Array<T | "ellipsis"> {
  if (items.length <= max) return [...items];
  const first = items[0];
  const tail = items.slice(items.length - (max - 1));
  return first === undefined ? [...tail] : [first, "ellipsis", ...tail];
}

export const EMOJI_CHOICES: string[] = [
  "📄","📝","📌","📋","🗂️","📁","📂","🗃️","🗄️",
  "✅","☑️","🎯","🚀","💡","🔥","⭐","✨","🌟",
  "📈","📊","📉","💼","🧾","💰","🏷️","🔖","🧭",
  "🛠️","⚙️","🧰","🔧","🔩","🧪","🧬","🔬","🖥️",
  "🗓️","⏰","⏳","🔔","📣","📢","💬","📮","📬",
  "🏠","🏢","🏗️","🌍","🌱","🌳","☀️","🌙","⚡",
  "🎨","🎬","🎵","📷","🕹️","🧩","🏆","🥇","🎁",
  "🧠","👋","👀","🙌","🤝","❤️","😀","🤔","🐣",
];
