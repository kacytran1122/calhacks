import type { Metadata } from "next";

export const metadata: Metadata = { title: "S’mile Trip Planner · Privacy" };

const sectionStyle = { marginTop: "2.2rem" } as const;
const headingStyle = { fontSize: "1.25rem", marginBottom: ".55rem" } as const;

export default function PrivacyPage() {
  return (
    <main style={{ minHeight: "100vh", background: "#fffaf2", color: "#29163d", padding: "clamp(2rem, 7vw, 5rem) 1.25rem", fontFamily: "system-ui, sans-serif" }}>
      <article style={{ maxWidth: 760, margin: "0 auto", lineHeight: 1.65 }}>
        <a href="/" style={{ color: "#29163d", fontWeight: 900, textDecoration: "none", fontSize: "1.2rem" }}>s’☺mile</a>
        <h1 style={{ fontSize: "clamp(2.4rem, 8vw, 4.8rem)", lineHeight: .96, letterSpacing: "-.055em", margin: "2rem 0 1rem" }}>Trip Planner privacy</h1>
        <p style={{ color: "#6f6075", fontSize: "1.05rem" }}>Last updated October 25, 2026</p>
        <p>S’mile Trip Planner has one purpose: build the fastest route and clear alternatives from a traveler’s chosen starting point to the collegiate hackathon they are viewing.</p>

        <section style={sectionStyle}>
          <h2 style={headingStyle}>What the extension uses</h2>
          <p>After you choose an event and explicitly allow location use, the extension may process your precise coordinates. You can instead enter a ZIP code, city, or address. It also reads the public event name, date, location, image, and URL from the page you opened, plus your self-drive preference.</p>
        </section>

        <section style={sectionStyle}>
          <h2 style={headingStyle}>How the data is used</h2>
          <p>The extension sends the starting point, selected public event details, and self-drive choice over HTTPS to S’mile’s routing endpoint at calhacks-beta.vercel.app. The endpoint uses OpenStreetMap Nominatim for place lookup, Transitous for public-transit routes, and OSRM with OpenStreetMap data for driving routes. These services receive the coordinates or place names needed to answer the route request.</p>
        </section>

        <section style={sectionStyle}>
          <h2 style={headingStyle}>Storage and retention</h2>
          <p>The extension stores only the starting text you entered and your self-drive preference in Chrome local storage so the next plan is faster. It does not store precise GPS coordinates. The route endpoint does not intentionally persist your route request. Hosting providers may retain ordinary security logs such as IP address, request time, and error details for limited operational purposes.</p>
          <p>On the website, nearby-event searches stay at the root address without adding your starting point to the URL. Your typed starting place and whether the event view is open may be remembered in this tab’s session storage. Precise GPS coordinates remain in page memory only and are not saved there or in browser history state. After a full refresh, please allow location access again if you want to use your precise location instead of your typed starting point. Older links may already contain location details; opening one removes those details from the current address, but cannot remove earlier copies, logs, or history entries elsewhere.</p>
        </section>

        <section style={sectionStyle}>
          <h2 style={headingStyle}>What the extension does not access</h2>
          <p>The extension does not read cookies, passwords, account information, private messages, browsing history, form entries, financial information, or pages that you have not opened. On sites other than the MLH season schedule, it reads the active page only after you click the extension.</p>
        </section>

        <section style={sectionStyle}>
          <h2 style={headingStyle}>Optional iMessage conversations</h2>
          <p>If you add S’mile’s Photon number to an iMessage conversation, the agent responds only to messages that explicitly mention @smile. Photon delivers those messages to S’mile, and the message and relevant saved conversation history may be sent to Anthropic to prepare a reply. The extension does not read your Messages app.</p>
          <p>S’mile saves a limited conversation history, each sender’s travel preferences and follow-up answers, selected events, and message results on its persistent server so context survives restarts and retries do not create duplicate trips. Sender and group identifiers are hashed for internal chat storage, but anything you type in a message can still contain personal information. Saved message results and trip records remain until removed by an administrator; please use the contact below for a deletion request. Approval links are sent privately to the requesting traveler and should not be forwarded.</p>
        </section>

        <section style={sectionStyle}>
          <h2 style={headingStyle}>Optional venue photo contributions</h2>
          <p>If you choose to contribute venue photos, S’mile uploads the selected images, event name, public event website, and any venue location you enter to its persistent server. We remove embedded image metadata and store both the image data and submission details in a private database for review and possible venue modelling. Earlier file-based submissions may retain a private original copy during migration to database storage. We do not automatically publish the photos or create a 3D tour from an upload, and these contributions are not automatically sent to a model-training service.</p>
          <p>Please share only photos you own or have permission to use, without faces, private information, or restricted areas. Photos and submission records remain until removed by an administrator. Keep the submission reference and contact us below if you want your contribution deleted. For abuse prevention, a short-lived hash of the connection identifier is used to limit uploads; we do not store the raw identifier in contribution records.</p>
        </section>

        <section style={sectionStyle}>
          <h2 style={headingStyle}>Limited use</h2>
          <p>Location and public page data are used only to provide and improve the trip-planning feature described above. They are not sold, used for advertising, transferred for credit decisions, or used for an unrelated purpose. S’mile’s use of information received through Chrome follows the Chrome Web Store User Data Policy, including its Limited Use requirements.</p>
        </section>

        <section style={sectionStyle}>
          <h2 style={headingStyle}>Your choices</h2>
          <p>You can deny the browser location prompt and use a typed starting point. You can clear the website’s saved starting place by clearing its session storage, and clear extension preferences by removing the extension or clearing its extension data. You can stop extension page access by closing the panel or uninstalling the extension.</p>
        </section>

        <section style={sectionStyle}>
          <h2 style={headingStyle}>Contact</h2>
          <p>For privacy questions or deletion requests, contact the developer through <a href="https://github.com/kacytran1122/calhacks" style={{ color: "#b33e36", fontWeight: 750 }}>the S’mile project repository</a>.</p>
        </section>
      </article>
    </main>
  );
}
