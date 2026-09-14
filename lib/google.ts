import { Readable } from "node:stream";
import { google, type calendar_v3, type drive_v3, type gmail_v1 } from "googleapis";
import { env } from "./env.js";
import { stripQuoted } from "./mail.js";
import type { Tenant } from "./tenant.js";

/**
 * A customer's own Google account (calendar, own inbox, Drive), connected once through OAuth on the
 * settings page. Every action here runs as that customer.
 * Scopes: calendar, gmail.modify (read/label/draft; the agent never sends as the customer), drive.file.
 */
export const GOOGLE_SCOPES = ["https://www.googleapis.com/auth/calendar", "https://www.googleapis.com/auth/gmail.modify", "https://www.googleapis.com/auth/drive.file"];

export function oauthClient(redirectUri?: string) {
  return new google.auth.OAuth2(env.google.clientId(), env.google.clientSecret(), redirectUri);
}

function ownerAuth(t: Tenant) {
  if (!t.googleRefreshToken) throw new Error("This user has not connected their Google account (Settings > Connect Google).");
  const auth = oauthClient();
  auth.setCredentials({ refresh_token: t.googleRefreshToken });
  return auth;
}

const calendarFor = (t: Tenant): calendar_v3.Calendar => google.calendar({ version: "v3", auth: ownerAuth(t) });
const gmailFor = (t: Tenant): gmail_v1.Gmail => google.gmail({ version: "v1", auth: ownerAuth(t) });
const driveFor = (t: Tenant): drive_v3.Drive => google.drive({ version: "v3", auth: ownerAuth(t) });

// ---------------------------------------------------------------- Calendar

export interface CalendarInput {
  action: "list" | "free_slots" | "create" | "update" | "delete";
  from?: string;
  to?: string;
  duration_minutes?: number;
  event_id?: string;
  title?: string;
  start?: string;
  end?: string;
  all_day?: boolean;
  location?: string;
  description?: string;
  attendees?: string[];
  notify_attendees?: boolean;
  calendar_id?: string;
}

function eventSummary(e: calendar_v3.Schema$Event) {
  return {
    id: e.id,
    title: e.summary ?? "(no title)",
    start: e.start?.dateTime ?? e.start?.date,
    end: e.end?.dateTime ?? e.end?.date,
    location: e.location ?? undefined,
    attendees: e.attendees?.map((a) => `${a.email}${a.responseStatus ? ` (${a.responseStatus})` : ""}`),
    link: e.htmlLink ?? undefined,
    description: e.description ? e.description.slice(0, 500) : undefined,
  };
}

export async function runCalendar(t: Tenant, input: CalendarInput): Promise<unknown> {
  const calendar = () => calendarFor(t);
  const tz = () => t.timezone;
  const calendarId = input.calendar_id || "primary";
  const now = new Date();
  switch (input.action) {
    case "list": {
      const { data } = await calendar().events.list({
        calendarId,
        timeMin: input.from ?? now.toISOString(),
        timeMax: input.to ?? new Date(now.getTime() + 7 * 86_400_000).toISOString(),
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 50,
      });
      return (data.items ?? []).map(eventSummary);
    }
    case "free_slots": {
      const from = new Date(input.from ?? now.toISOString());
      const to = new Date(input.to ?? new Date(from.getTime() + 7 * 86_400_000).toISOString());
      const dur = (input.duration_minutes ?? 30) * 60_000;
      const { data } = await calendar().freebusy.query({
        requestBody: { timeMin: from.toISOString(), timeMax: to.toISOString(), timeZone: tz(), items: [{ id: calendarId }] },
      });
      const busy = (data.calendars?.[calendarId]?.busy ?? [])
        .map((b) => ({ s: new Date(b.start!).getTime(), e: new Date(b.end!).getTime() }))
        .sort((a, b) => a.s - b.s);
      const slots: Array<{ start: string; end: string }> = [];
      let cursor = from.getTime();
      for (const b of busy) {
        if (b.s - cursor >= dur) slots.push({ start: new Date(cursor).toISOString(), end: new Date(b.s).toISOString() });
        cursor = Math.max(cursor, b.e);
      }
      if (to.getTime() - cursor >= dur) slots.push({ start: new Date(cursor).toISOString(), end: to.toISOString() });
      return { timezone: tz(), free: slots.slice(0, 40), note: "Apply the owner's work hours and commute from profile.md before proposing a slot." };
    }
    case "create": {
      if (!input.title || !input.start) throw new Error("title and start are required");
      const body: calendar_v3.Schema$Event = {
        summary: input.title,
        location: input.location,
        description: input.description,
        start: input.all_day ? { date: input.start.slice(0, 10) } : { dateTime: input.start, timeZone: tz() },
        end: input.all_day
          ? { date: (input.end ?? input.start).slice(0, 10) }
          : { dateTime: input.end ?? new Date(new Date(input.start).getTime() + 60 * 60_000).toISOString(), timeZone: tz() },
        attendees: input.attendees?.map((email) => ({ email })),
      };
      const { data } = await calendar().events.insert({ calendarId, requestBody: body, sendUpdates: input.notify_attendees ? "all" : "none" });
      return eventSummary(data);
    }
    case "update": {
      if (!input.event_id) throw new Error("event_id is required");
      const patch: calendar_v3.Schema$Event = {};
      if (input.title) patch.summary = input.title;
      if (input.location !== undefined) patch.location = input.location;
      if (input.description !== undefined) patch.description = input.description;
      if (input.start) patch.start = input.all_day ? { date: input.start.slice(0, 10) } : { dateTime: input.start, timeZone: tz() };
      if (input.end) patch.end = input.all_day ? { date: input.end.slice(0, 10) } : { dateTime: input.end, timeZone: tz() };
      if (input.attendees) patch.attendees = input.attendees.map((email) => ({ email }));
      const { data } = await calendar().events.patch({ calendarId, eventId: input.event_id, requestBody: patch, sendUpdates: input.notify_attendees ? "all" : "none" });
      return eventSummary(data);
    }
    case "delete": {
      if (!input.event_id) throw new Error("event_id is required");
      await calendar().events.delete({ calendarId, eventId: input.event_id, sendUpdates: input.notify_attendees ? "all" : "none" });
      return { deleted: input.event_id };
    }
    default:
      throw new Error(`unknown calendar action ${String(input.action)}`);
  }
}

// ---------------------------------------------------------------- Owner inbox

export interface OwnerInboxInput {
  action: "search" | "read" | "draft" | "label" | "archive" | "mark_read" | "list_labels";
  query?: string;
  max?: number;
  message_id?: string;
  thread_id?: string;
  to?: string;
  cc?: string;
  subject?: string;
  body?: string;
  add_labels?: string[];
  remove_labels?: string[];
}

function header(msg: gmail_v1.Schema$Message, name: string): string {
  return msg.payload?.headers?.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value ?? "";
}

function decodeBody(part: gmail_v1.Schema$MessagePart | undefined): string {
  if (!part) return "";
  let text = "";
  let html = "";
  const walk = (p: gmail_v1.Schema$MessagePart) => {
    const data = p.body?.data ? Buffer.from(p.body.data.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8") : "";
    if (p.mimeType === "text/plain") text += data;
    else if (p.mimeType === "text/html") html += data;
    for (const c of p.parts ?? []) walk(c);
  };
  walk(part);
  return text.trim() || html.replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

export async function runOwnerInbox(t: Tenant, input: OwnerInboxInput): Promise<unknown> {
  const g = gmailFor(t);
  switch (input.action) {
    case "search": {
      const { data } = await g.users.messages.list({ userId: "me", q: input.query ?? "in:inbox", maxResults: Math.min(input.max ?? 20, 50) });
      const ids = (data.messages ?? []).map((m) => m.id!);
      const out = [];
      for (const id of ids) {
        const { data: msg } = await g.users.messages.get({ userId: "me", id, format: "metadata", metadataHeaders: ["From", "To", "Subject", "Date"] });
        out.push({
          id: msg.id,
          thread_id: msg.threadId,
          from: header(msg, "From"),
          subject: header(msg, "Subject"),
          date: header(msg, "Date"),
          snippet: msg.snippet,
          labels: msg.labelIds,
          unread: msg.labelIds?.includes("UNREAD") ?? false,
        });
      }
      return out;
    }
    case "read": {
      if (!input.message_id) throw new Error("message_id is required");
      const { data: msg } = await g.users.messages.get({ userId: "me", id: input.message_id, format: "full" });
      const body = decodeBody(msg.payload);
      return {
        id: msg.id,
        thread_id: msg.threadId,
        from: header(msg, "From"),
        to: header(msg, "To"),
        cc: header(msg, "Cc"),
        subject: header(msg, "Subject"),
        date: header(msg, "Date"),
        message_id_header: header(msg, "Message-ID"),
        body: body.length > 20_000 ? body.slice(0, 20_000) + "\n...(truncated)" : body,
        new_text_only: stripQuoted(body).slice(0, 8000),
        attachments: listAttachmentNames(msg.payload),
      };
    }
    case "draft": {
      // A draft in the OWNER's Gmail, in the owner's voice, for the owner to send with one tap.
      if (!input.to || !input.subject || !input.body) throw new Error("to, subject and body are required");
      const headers = [`To: ${input.to}`, ...(input.cc ? [`Cc: ${input.cc}`] : []), `Subject: ${input.subject}`, "MIME-Version: 1.0", "Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64"];
      if (input.message_id) {
        const { data: orig } = await g.users.messages.get({ userId: "me", id: input.message_id, format: "metadata", metadataHeaders: ["Message-ID"] });
        const mid = header(orig, "Message-ID");
        if (mid) headers.push(`In-Reply-To: ${mid}`, `References: ${mid}`);
      }
      const raw = Buffer.from(headers.join("\r\n") + "\r\n\r\n" + Buffer.from(input.body, "utf8").toString("base64")).toString("base64url");
      const { data } = await g.users.drafts.create({ userId: "me", requestBody: { message: { raw, threadId: input.thread_id } } });
      return { draft_id: data.id, note: "Saved as a draft in the owner's Gmail. Tell the owner it is ready to send; never send as the owner." };
    }
    case "label": {
      if (!input.message_id && !input.thread_id) throw new Error("message_id or thread_id is required");
      const labels = await labelIds(g, [...(input.add_labels ?? []), ...(input.remove_labels ?? [])]);
      const body = { addLabelIds: (input.add_labels ?? []).map((l) => labels[l]).filter(Boolean), removeLabelIds: (input.remove_labels ?? []).map((l) => labels[l]).filter(Boolean) };
      if (input.thread_id) await g.users.threads.modify({ userId: "me", id: input.thread_id, requestBody: body });
      else await g.users.messages.modify({ userId: "me", id: input.message_id!, requestBody: body });
      return { ok: true, ...body };
    }
    case "archive": {
      const id = input.thread_id ?? input.message_id;
      if (!id) throw new Error("message_id or thread_id is required");
      if (input.thread_id) await g.users.threads.modify({ userId: "me", id, requestBody: { removeLabelIds: ["INBOX"] } });
      else await g.users.messages.modify({ userId: "me", id, requestBody: { removeLabelIds: ["INBOX"] } });
      return { archived: id };
    }
    case "mark_read": {
      if (!input.message_id) throw new Error("message_id is required");
      await g.users.messages.modify({ userId: "me", id: input.message_id, requestBody: { removeLabelIds: ["UNREAD"] } });
      return { ok: true };
    }
    case "list_labels": {
      const { data } = await g.users.labels.list({ userId: "me" });
      return (data.labels ?? []).map((l) => l.name);
    }
    default:
      throw new Error(`unknown inbox action ${String(input.action)}`);
  }
}

function listAttachmentNames(part: gmail_v1.Schema$MessagePart | undefined): string[] {
  const out: string[] = [];
  const walk = (p: gmail_v1.Schema$MessagePart) => {
    if (p.filename) out.push(p.filename);
    for (const c of p.parts ?? []) walk(c);
  };
  if (part) walk(part);
  return out;
}

/** Map label names to ids, creating user labels that do not exist yet (system labels are used as-is). */
async function labelIds(g: gmail_v1.Gmail, names: string[]): Promise<Record<string, string>> {
  const { data } = await g.users.labels.list({ userId: "me" });
  const byName = new Map((data.labels ?? []).map((l) => [l.name!.toLowerCase(), l.id!]));
  const out: Record<string, string> = {};
  for (const name of names) {
    const system = ["INBOX", "UNREAD", "STARRED", "IMPORTANT", "SPAM", "TRASH"].includes(name.toUpperCase());
    if (system) {
      out[name] = name.toUpperCase();
      continue;
    }
    let id = byName.get(name.toLowerCase());
    if (!id) {
      const { data: created } = await g.users.labels.create({ userId: "me", requestBody: { name, labelListVisibility: "labelShow", messageListVisibility: "show" } });
      id = created.id!;
    }
    out[name] = id;
  }
  return out;
}


// ---------------------------------------------------------------- Drive

export interface DriveInput {
  action: "save" | "list" | "search" | "read";
  /** For save: filename under /mnt/session/outputs to upload. */
  filename?: string;
  folder?: string;
  query?: string;
  file_id?: string;
}

async function folderId(drive: () => drive_v3.Drive, name?: string): Promise<string | undefined> {
  const root = await rootFolder(drive);
  if (!name) return root;
  const q = `name = '${name.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false${root ? ` and '${root}' in parents` : ""}`;
  const { data } = await drive().files.list({ q, fields: "files(id,name)", pageSize: 1 });
  if (data.files?.[0]?.id) return data.files[0].id;
  const { data: created } = await drive().files.create({
    requestBody: { name, mimeType: "application/vnd.google-apps.folder", parents: root ? [root] : undefined },
    fields: "id",
  });
  return created.id ?? undefined;
}

/** Everything the agent files lives under one "Assistant" folder in the customer's Drive. */
async function rootFolder(drive: () => drive_v3.Drive): Promise<string | undefined> {
  const { data } = await drive().files.list({ q: "name = 'Assistant' and mimeType = 'application/vnd.google-apps.folder' and trashed = false and 'root' in parents", fields: "files(id)", pageSize: 1 });
  if (data.files?.[0]?.id) return data.files[0].id;
  const { data: created } = await drive().files.create({ requestBody: { name: "Assistant", mimeType: "application/vnd.google-apps.folder" }, fields: "id" });
  return created.id ?? undefined;
}

export async function driveSave(t: Tenant, opts: { filename: string; mimeType: string; content: Buffer; folder?: string }): Promise<{ id: string; link: string }> {
  const drive = () => driveFor(t);
  const parent = await folderId(drive, opts.folder);
  const { data } = await drive().files.create({
    requestBody: { name: opts.filename, parents: parent ? [parent] : undefined },
    media: { mimeType: opts.mimeType, body: Readable.from(opts.content) },
    fields: "id,webViewLink",
  });
  return { id: data.id!, link: data.webViewLink ?? "" };
}

export async function driveList(t: Tenant, opts: { folder?: string; query?: string }): Promise<Array<{ id: string; name: string; modified: string; link: string }>> {
  const drive = () => driveFor(t);
  const parent = await folderId(drive, opts.folder);
  const parts = ["trashed = false"];
  if (parent) parts.push(`'${parent}' in parents`);
  if (opts.query) parts.push(`fullText contains '${opts.query.replace(/'/g, "\\'")}'`);
  const { data } = await drive().files.list({ q: parts.join(" and "), fields: "files(id,name,modifiedTime,webViewLink)", orderBy: "modifiedTime desc", pageSize: 50 });
  return (data.files ?? []).map((f) => ({ id: f.id!, name: f.name!, modified: f.modifiedTime ?? "", link: f.webViewLink ?? "" }));
}

export async function driveRead(t: Tenant, fileId: string): Promise<{ name: string; mimeType: string; content: Buffer }> {
  const drive = () => driveFor(t);
  const { data: metaData } = await drive().files.get({ fileId, fields: "name,mimeType" });
  const mimeType = metaData.mimeType ?? "application/octet-stream";
  if (mimeType.startsWith("application/vnd.google-apps.")) {
    const exportMime = mimeType.endsWith("spreadsheet") ? "text/csv" : "text/plain";
    const res = await drive().files.export({ fileId, mimeType: exportMime }, { responseType: "arraybuffer" });
    return { name: `${metaData.name}.${exportMime === "text/csv" ? "csv" : "txt"}`, mimeType: exportMime, content: Buffer.from(res.data as ArrayBuffer) };
  }
  const res = await drive().files.get({ fileId, alt: "media" }, { responseType: "arraybuffer" });
  return { name: metaData.name ?? fileId, mimeType, content: Buffer.from(res.data as ArrayBuffer) };
}
