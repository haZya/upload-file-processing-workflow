import { GetObjectCommand, HeadObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { fileTypeFromBuffer } from "file-type";
import { ensureUploadRecord, findLatestUploadByStagingKey } from "./utils/uploads-table";

const s3 = new S3Client({});

export async function handler(event: { bucket: string; key: string; finalKey?: string }) {
    const { bucket, key } = event;
    const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    const upload = await findLatestUploadByStagingKey(key);
    const context = await ensureUploadRecord({
        bucket,
        key,
        head,
        upload,
        pendingMessage: "Upload record created during validation fallback",
    });

    if (!context.authorSubId) {
        throw new Error("Missing author-id metadata on uploaded object");
    }

    const object = await s3.send(new GetObjectCommand({
        Bucket: bucket,
        Key: key,
        Range: "bytes=0-4095", // A few KB is usually enough to get the magic number.
    }));

    if (!object.Body) {
        throw new Error("Failed to read file bytes");
    }

    const buffer = await object.Body.transformToByteArray();
    const detected = await fileTypeFromBuffer(buffer);
    const detectedMime = detected?.mime ?? null;
    const mime = detectedMime ?? head.ContentType ?? "application/octet-stream";
    const isValid = !(detectedMime && head.ContentType && detectedMime !== head.ContentType);

    return {
        ...event,
        ...context,
        isValid,
        ...(isValid ? { mime } : { message: "Invalid file type" }),
        authorSubId: context.authorSubId,
        contentType: head.ContentType,
        contentLength: head.ContentLength,
    };
}
