export function EventThumb() {
  return (
    <div className="evthumb">
      <svg className="et-route" viewBox="0 0 320 170" preserveAspectRatio="none" aria-hidden="true">
        <path d="M-10 150 C70 140 110 70 180 80 S270 50 300 34" fill="none" stroke="var(--color-accent-300)" strokeWidth="3" strokeDasharray="2 10" strokeLinecap="round" />
      </svg>
      <span className="et-ghost">36h</span>
      <span className="et-pin">
        <svg width="20" height="20" viewBox="0 0 22 22" aria-hidden="true">
          <ellipse cx="7.5" cy="8.5" rx="1.5" ry="1.8" fill="var(--plum)" />
          <ellipse cx="14.5" cy="8.5" rx="1.5" ry="1.8" fill="var(--plum)" />
          <path d="M6 13 Q11 17.5 16 13" fill="none" stroke="var(--plum)" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </span>
      <div className="et-date">
        <span>Nov</span>
        <b>14</b>
      </div>
      <div className="et-body">
        <span className="et-tag">Hackathon · 36 hours</span>
        <div className="et-name">Golden Gate Hack</div>
        <div className="et-meta">Fort Mason · San Francisco · 9:00 am</div>
      </div>
    </div>
  );
}
