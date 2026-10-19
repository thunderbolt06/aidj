import Link from "next/link";
import type { ReactNode } from "react";

/** Inline: **bold**, `code`, [text](/path). */
function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith("**")) out.push(<strong key={k++}>{t.slice(2, -2)}</strong>);
    else if (t.startsWith("`")) out.push(<code key={k++}>{t.slice(1, -1)}</code>);
    else {
      const [, label, href] = /\[([^\]]+)\]\(([^)]+)\)/.exec(t)!;
      out.push(
        href.startsWith("/") ? (
          <Link key={k++} href={href}>{label}</Link>
        ) : (
          <a key={k++} href={href} rel="noopener noreferrer">{label}</a>
        )
      );
    }
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Renders the tiny markdown subset used by lib/site/posts.ts. */
export function Prose({ source }: { source: string }) {
  const blocks = source.trim().split(/\n{2,}/);
  const nodes: ReactNode[] = [];
  blocks.forEach((raw, i) => {
    const b = raw.trim();
    if (b.startsWith("### ")) nodes.push(<h3 key={i}>{inline(b.slice(4))}</h3>);
    else if (b.startsWith("## ")) nodes.push(<h2 key={i}>{inline(b.slice(3))}</h2>);
    else if (b.startsWith("> ")) nodes.push(<blockquote key={i}>{inline(b.replace(/^> ?/gm, ""))}</blockquote>);
    else if (/^- /.test(b))
      nodes.push(<ul key={i}>{b.split("\n").map((l, j) => <li key={j}>{inline(l.replace(/^- /, ""))}</li>)}</ul>);
    else if (/^\d+\. /.test(b))
      nodes.push(<ol key={i}>{b.split("\n").map((l, j) => <li key={j}>{inline(l.replace(/^\d+\. /, ""))}</li>)}</ol>);
    else nodes.push(<p key={i}>{inline(b.replace(/\n/g, " "))}</p>);
  });
  return <div className="ep-prose">{nodes}</div>;
}
