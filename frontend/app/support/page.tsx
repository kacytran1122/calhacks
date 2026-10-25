import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "S’mile Trip Planner · Support",
  description: "Help and troubleshooting for the S’mile Trip Planner Chrome extension.",
};

const sectionStyle = { marginTop: "2.2rem" } as const;
const headingStyle = { fontSize: "1.25rem", marginBottom: ".55rem" } as const;
const linkStyle = { color: "#b33e36", fontWeight: 750 } as const;

export default function SupportPage() {
  return (
    <main style={{ minHeight: "100vh", background: "#fffaf2", color: "#29163d", padding: "clamp(2rem, 7vw, 5rem) 1.25rem", fontFamily: "system-ui, sans-serif" }}>
      <article style={{ maxWidth: 760, margin: "0 auto", lineHeight: 1.65 }}>
        <a href="/" style={{ color: "#29163d", fontWeight: 900, textDecoration: "none", fontSize: "1.2rem" }}>s’☺mile</a>
        <h1 style={{ fontSize: "clamp(2.4rem, 8vw, 4.8rem)", lineHeight: .96, letterSpacing: "-.055em", margin: "2rem 0 1rem" }}>Trip Planner support</h1>
        <p style={{ color: "#6f6075", fontSize: "1.05rem" }}>Help with event detection, location access, and live route planning.</p>

        <section style={sectionStyle}>
          <h2 style={headingStyle}>The event was not detected</h2>
          <p>Open an official collegiate hackathon page, then click the S’mile toolbar icon. On the MLH season schedule, use the Plan trip with S’mile button on the event card. You can correct the destination in the planner before requesting a route.</p>
        </section>

        <section style={sectionStyle}>
          <h2 style={headingStyle}>Location access was denied</h2>
          <p>You can continue without GPS. Enter a ZIP code, city, or full address as your starting point, select whether self-driving is available, and request the route again.</p>
        </section>

        <section style={sectionStyle}>
          <h2 style={headingStyle}>No route was returned</h2>
          <p>Confirm that the starting point and event destination are specific enough. Public-transit availability depends on current Transitous coverage and schedules. Try again closer to departure or enable self-driving to compare a road route.</p>
        </section>

        <section style={sectionStyle}>
          <h2 style={headingStyle}>Privacy and data</h2>
          <p>S’mile uses the selected public event details and the starting point you provide only to build the requested route. Read the complete <a href="/privacy" style={linkStyle}>privacy policy</a> for details about permissions, storage, and retention.</p>
        </section>

        <section style={sectionStyle}>
          <h2 style={headingStyle}>More help</h2>
          <p>Return to the <a href="/" style={linkStyle}>S’mile website</a> to review the product workflow and current service status.</p>
        </section>
      </article>
    </main>
  );
}
