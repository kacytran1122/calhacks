import type { CSSProperties } from "react";

function Face({ tail = "currentColor", className, width, height, style }: { tail?: string; className?: string; width?: number; height?: number; style?: CSSProperties }) {
  return (
    <svg className={className} width={width} height={height} viewBox="0 0 22 30" aria-hidden="true" style={style}>
      <circle cx="11" cy="11" r="9" fill="var(--butter)" stroke="var(--plum)" strokeWidth="2.4" />
      <ellipse className="eye" cx="8" cy="9.5" rx="1.4" ry="1.7" fill="var(--plum)" />
      <ellipse className="eye" cx="14" cy="9.5" rx="1.4" ry="1.7" fill="var(--plum)" />
      <path d="M7.5 13 Q11 16.5 14.5 13" fill="none" stroke="var(--plum)" strokeWidth="1.8" strokeLinecap="round" />
      <path d="M14 19 Q13 25 8 28" fill="none" stroke={tail} strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

export function Smile() {
  return (
    <span className="lg">
      s<Face />
      mile
    </span>
  );
}

export function SmileWord({ size = "header" }: { size?: "header" | "footer" }) {
  const header = size === "header";
  return (
    <span className="lword" style={header ? undefined : { fontSize: 20 }}>
      s
      <Face className="lap" width={header ? 16 : 11} height={header ? 22 : 15} tail="var(--plum)" style={{ marginTop: header ? 2 : 1 }} />
      mile
    </span>
  );
}
