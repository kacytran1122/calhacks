import { NextResponse } from "next/server";
import { TOUR_UPLOAD_LIMITS, TourContributionError, tourContributionOriginAllowed, tourContributionStore } from "@smile/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

async function boundedForm(request: Request): Promise<FormData> {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > TOUR_UPLOAD_LIMITS.maxBodyBytes))
    throw new TourContributionError("Please keep the selected photos under 3 MB in total.", 413);
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^multipart\/form-data;\s*boundary=/i.test(contentType)) throw new TourContributionError("Please upload your photos using the contribution form.", 400);
  if (!request.body) throw new TourContributionError("Please select at least one photo.", 400);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const deadline = Date.now() + 20_000;
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              reject(new TourContributionError("The upload took too long. Please check your connection and try again.", 408));
              void reader.cancel().catch(() => {});
            }, Math.max(1, deadline - Date.now()));
          }),
        ]);
      } finally { if (timer) clearTimeout(timer); }
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > TOUR_UPLOAD_LIMITS.maxBodyBytes) {
        await reader.cancel();
        throw new TourContributionError("Please keep the selected photos under 3 MB in total.", 413);
      }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  try {
    return await new Request(request.url, { method: "POST", headers: { "content-type": contentType }, body: Buffer.concat(chunks) }).formData();
  } catch { throw new TourContributionError("The upload could not be read. Please select your photos and try again.", 400); }
}

export async function POST(request: Request) {
  if (!tourContributionOriginAllowed(request)) return NextResponse.json({ error: "Please submit photos from the S’mile website." }, { status: 403 });
  let store: ReturnType<typeof tourContributionStore> | undefined;
  let ticket: string | undefined;
  try {
    store = tourContributionStore();
    const source = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
    ticket = store.reserve(source);
    const form = await boundedForm(request);
    const allowed = new Set(["eventName", "eventUrl", "location", "consent", "photos"]);
    if ([...form.keys()].some((key) => !allowed.has(key)) || ["eventName", "eventUrl", "location", "consent"].some((key) => form.getAll(key).length > 1))
      throw new TourContributionError("Please submit one event with each batch of photos.", 400);
    const values = form.getAll("photos");
    if (values.length < 1 || values.length > TOUR_UPLOAD_LIMITS.maxPhotos || values.some((value) => typeof value === "string"))
      throw new TourContributionError("Please select between one and six photos.", 400);
    const files = values as File[];
    if (files.some((file) => file.size > TOUR_UPLOAD_LIMITS.maxPhotoBytes) || files.reduce((sum, file) => sum + file.size, 0) > TOUR_UPLOAD_LIMITS.maxTotalBytes)
      throw new TourContributionError("Please keep the selected photos under 3 MB in total.", 413);
    const fields = ["eventName", "eventUrl", "location", "consent"].map((key) => form.get(key));
    if (fields.some((field) => field !== null && typeof field !== "string")) throw new TourContributionError("Please enter valid event details.", 400);
    const receipt = await store.receive(ticket, {
      eventName: fields[0] as string ?? "",
      eventUrl: fields[1] as string ?? "",
      location: fields[2] as string ?? "",
      consent: fields[3] === "true",
      photos: await Promise.all(files.map(async (file) => ({ bytes: new Uint8Array(await file.arrayBuffer()), contentType: file.type }))),
    });
    return NextResponse.json(receipt, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const known = error instanceof TourContributionError;
    return NextResponse.json({ error: known ? error.message : "Your photos could not be saved. Please try again later." }, {
      status: known ? error.status : 503,
      headers: { "Cache-Control": "no-store", ...(known && error.retryAfter ? { "Retry-After": String(error.retryAfter) } : {}) },
    });
  } finally {
    if (store && ticket) { try { store.release(ticket); } catch {} }
  }
}
