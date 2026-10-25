import type { Metadata } from "next";
import { ContributionForm } from "./ContributionForm";
import "./contribute.css";

export const metadata: Metadata = {
  title: "Contribute venue photos · S’mile",
  description: "Share photos of a hackathon venue to help prepare a future 3D tour.",
};

export default async function ContributePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const query = await searchParams;
  const text = (key: string, limit: number) => typeof query[key] === "string" ? query[key].slice(0, limit) : "";
  return <main className="tc-page">
    <nav><a href="/finding-events" className="tc-back">Back to events</a><a href="/landing" className="tc-brand">S’mile</a></nav>
    <section className="tc-intro"><span className="tc-eyebrow">Build the next view</span><h1>A few photos.<br />A place to begin.</h1><p>Help future hackers feel at home before they arrive. Share photos of this venue so we have material to prepare a 3D tour.</p></section>
    <ContributionForm initialEvent={text("event", 160)} initialUrl={text("url", 2048)} initialLocation={text("location", 240)} />
    <p className="tc-footnote">Contributions are saved privately for review. They do not automatically create or publish a 3D model. Please see our <a href="/privacy">privacy policy</a> for how submissions are handled.</p>
  </main>;
}
