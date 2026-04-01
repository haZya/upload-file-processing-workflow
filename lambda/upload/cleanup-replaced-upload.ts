import { DeleteObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { DeleteCommand } from "@aws-sdk/lib-dynamodb";
import { db, uploadsTableName } from "./utils/uploads-table";

const s3 = new S3Client({});
const uploadBucket = process.env.UPLOAD_BUCKET;

if (!uploadBucket) {
    throw new Error("UPLOAD_BUCKET environment variable is required");
}

interface PreviousUpload {
    uploadId: string;
    finalKey?: string;
    formats?: Array<{ key: string }>;
}

export async function handler(event: { previousUpload?: PreviousUpload; uploadId: string }) {
    const previousUpload = event.previousUpload;

    if (!previousUpload || previousUpload.uploadId === event.uploadId) {
        return event;
    }

    const keysToDelete = [
        previousUpload.finalKey,
        ...(previousUpload.formats?.map(format => format.key) ?? []),
    ].filter((key): key is string => Boolean(key));

    await Promise.all(keysToDelete.map(key => s3.send(new DeleteObjectCommand({
        Bucket: uploadBucket,
        Key: key,
    }))));

    await db.send(new DeleteCommand({
        TableName: uploadsTableName,
        Key: {
            uploadId: previousUpload.uploadId,
        },
    }));

    return event;
}
