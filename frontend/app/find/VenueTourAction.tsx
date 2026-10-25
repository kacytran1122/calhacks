import { contributionUrl, venueTourFor, type VenueTourEvent } from "@/lib/venueTours";

export function VenueTourAction({ event }: { event: VenueTourEvent }) {
  const tour = venueTourFor(event);
  return <div className="fd-tour-action">
    <span className="fd-tour-mark" aria-hidden="true"><svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6"><path d="m12 2 9 5v10l-9 5-9-5V7l9-5Z" /><path d="m3 7 9 5 9-5M12 12v10M7.5 4.5l9 5" /></svg></span>
    <div><b>{tour ? "Get to know the space" : "Help bring this venue to life"}</b><span>{tour ? "Explore a conceptual 3D walkthrough before you arrive." : "Share venue photos to help us build a future 3D tour."}</span></div>
    <a className="dk-btn ghost" href={tour?.href ?? contributionUrl(event)}>{tour ? "Immerse in a 3D tour" : "Contribute venue photos"}</a>
  </div>;
}
