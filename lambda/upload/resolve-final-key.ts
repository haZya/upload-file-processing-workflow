import { randomUUID } from "node:crypto";
import { extname } from "node:path";

export async function handler(event: { bucket: string; key: string; authorSubId: string }) {
    const extension = extname(event.key).toLowerCase();
    const finalKey = `uploads/${event.authorSubId}/${randomUUID()}${extension}`;

    return {
        ...event,
        finalKey,
    };
}
