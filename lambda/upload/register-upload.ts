import { HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { ensureUploadRecord } from "./utils/uploads-table";

const s3 = new S3Client({});

export async function handler(event: { bucket: string; key: string }) {
    const head = await s3.send(new HeadObjectCommand({
        Bucket: event.bucket,
        Key: event.key,
    }));
    const createdAt = new Date().toISOString();
    const context = await ensureUploadRecord({
        bucket: event.bucket,
        key: event.key,
        head,
        pendingMessage: "Waiting for malware scan result",
    });

    return {
        ...event,
        ...context,
        status: "PENDING_SCAN",
        createdAt,
    };
}
