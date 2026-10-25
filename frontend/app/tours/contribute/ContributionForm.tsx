"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";

const MAX_BYTES = 3 * 1024 * 1024;
const TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);
type Receipt = { receiptId: string; eventName: string; photoCount: number };

export function ContributionForm({ initialEvent = "", initialUrl = "", initialLocation = "" }: { initialEvent?: string; initialUrl?: string; initialLocation?: string }) {
  const [eventName, setEventName] = useState(initialEvent);
  const [eventUrl, setEventUrl] = useState(initialUrl);
  const [location, setLocation] = useState(initialLocation);
  const [photos, setPhotos] = useState<File[]>([]);
  const [previews, setPreviews] = useState<{ url: string; name: string }[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const pending = useRef(false);

  useEffect(() => {
    const next = photos.map((file) => ({ url: URL.createObjectURL(file), name: file.name }));
    setPreviews(next);
    return () => next.forEach((preview) => URL.revokeObjectURL(preview.url));
  }, [photos]);

  const selectPhotos = (files: FileList | null) => {
    const selected = Array.from(files ?? []);
    setError("");
    setPhotos([]);
    if (!selected.length) return;
    if (selected.length > 6) return setError("Please choose up to six photos per submission.");
    if (selected.some((file) => !TYPES.has(file.type))) return setError("Please choose JPEG, PNG, or WebP photos.");
    if (selected.some((file) => !file.size) || selected.reduce((total, file) => total + file.size, 0) > MAX_BYTES) return setError("Please keep the selected photos within 3 MB in total. You can send another batch afterwards.");
    setPhotos(selected);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending.current) return;
    setError("");
    if (!photos.length) return setError("Please choose at least one venue photo.");
    const data = new FormData(event.currentTarget);
    data.delete("photos");
    photos.forEach((photo) => data.append("photos", photo));
    pending.current = true;
    setBusy(true);
    try {
      const response = await fetch("/api/tours/contributions", { method: "POST", body: data, signal: AbortSignal.timeout(60_000) });
      const body = await response.json().catch(() => null) as (Receipt & { error?: string }) | null;
      if (!response.ok) throw new Error(body?.error ?? (response.status === 413 ? "These photos are too large for one upload. Please try a smaller batch." : "We couldn’t save your photos. Please try again."));
      if (!body?.receiptId || !Number.isInteger(body.photoCount) || !body.eventName) throw new Error("The upload could not be confirmed. Please try again before closing this page.");
      setReceipt(body);
      setPhotos([]);
    } catch (failure) {
      setError(failure instanceof Error && failure.name === "TimeoutError" ? "The upload took too long to confirm. Please try again with a smaller batch." : failure instanceof Error ? failure.message : "We couldn’t save your photos. Please try again.");
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };

  if (receipt) return <section className="tc-receipt" role="status"><span className="tc-eyebrow">Safely received</span><h2>Thank you for the new perspective.</h2><p>Your {receipt.photoCount} {receipt.photoCount === 1 ? "photo has" : "photos have"} been saved for <b>{receipt.eventName}</b>. We’ll review the material before deciding whether a 3D tour can be built.</p><p className="tc-receipt-id">Submission reference<br /><code>{receipt.receiptId}</code></p><p>Nothing has been published, and a new tour is not available yet.</p><div className="tc-receipt-actions"><button type="button" className="tc-submit" onClick={() => setReceipt(null)}>Contribute another batch</button><a href="/finding-events">Return to events</a></div></section>;

  return <form className="tc-form" onSubmit={submit}>
    <fieldset disabled={busy}>
      <legend>About the venue</legend>
      <label>Event name<input name="eventName" value={eventName} onChange={(event) => setEventName(event.target.value)} maxLength={160} required autoComplete="off" /></label>
      <label>Official event website<input name="eventUrl" type="url" value={eventUrl} onChange={(event) => setEventUrl(event.target.value)} maxLength={2048} required placeholder="https://your-hackathon.org" /></label>
      <label>Building or venue location <span>(optional)</span><input name="location" value={location} onChange={(event) => setLocation(event.target.value)} maxLength={240} placeholder="Building name, campus, and city" /></label>
      <div className="tc-upload"><label htmlFor="venue-photos"><b>Give us a look around</b><span>Choose up to six JPEG, PNG, or WebP photos, within 3 MB total.</span></label><input id="venue-photos" name="photos" type="file" accept="image/jpeg,image/png,image/webp" multiple onChange={(event) => selectPhotos(event.target.files)} aria-describedby="venue-photo-tips" /><p id="venue-photo-tips">Different angles of the exterior, entrance, and rooms are helpful. Please avoid faces, badges, private information, and areas you don’t have permission to photograph.</p></div>
      {previews.length > 0 && <div className="tc-previews">{previews.map((preview, index) => <figure key={`${preview.url}-${index}`}><img src={preview.url} alt={`Selected venue photo ${index + 1}`} /><figcaption>{preview.name}</figcaption></figure>)}</div>}
      <label className="tc-consent"><input type="checkbox" name="consent" value="true" required /><span>I own these photos or have permission to share them, and I agree that S’mile may store and review them to prepare a venue model. I have not included private or sensitive information.</span></label>
      {error && <p className="tc-error" role="alert">{error}</p>}
      <button className="tc-submit" type="submit" disabled={busy}>{busy ? "Saving your photos…" : "Send venue photos"}</button>
      <p className="tc-form-note">Your photos stay private during review. Embedded image metadata is removed before storage.</p>
    </fieldset>
  </form>;
}
