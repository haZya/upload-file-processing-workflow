import { GetCommand, PutCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import type { UploadFormat, UploadStatus } from "./utils/uploads-table";
import {
    db,
    findLatestUploadByStagingKey,
    type UploadRecord,
    uploadRelationsTableName,
    uploadsTableName,
} from "./utils/uploads-table";

export async function handler(event: {
    key: string;
    uploadId?: string;
    relationKey?: string;
    finalKey?: string;
    formats?: UploadFormat[];
    error?: unknown;
    handledStatus?: UploadStatus;
}) {
    const { key, uploadId, relationKey, finalKey, formats, error, handledStatus } = event;
    const updatedAt = new Date().toISOString();
    const upload = uploadId
        ? { uploadId: uploadId }
        : await findLatestUploadByStagingKey(key);

    if (!upload?.uploadId) {
        throw new Error(`Upload record not found for staging key ${key}`);
    }

    const status: UploadStatus = handledStatus ?? {
        isSuccess: !error,
        name: error ? "UPLOAD_FAILED" : "UPLOAD_COMPLETE",
        message: error ? "File processing failed" : "File processed successfully",
    };

    await db.send(new UpdateCommand({
        TableName: uploadsTableName,
        Key: {
            uploadId: upload.uploadId,
        },
        UpdateExpression: "SET #status = :status, updatedAt = :updatedAt",
        ExpressionAttributeNames: {
            "#status": "status",
        },
        ExpressionAttributeValues: {
            ":status": status,
            ":updatedAt": updatedAt,
        },
    }));

    if (status.name === "UPLOAD_COMPLETE" && relationKey) {
        const relation = await db.send(new GetCommand({
            TableName: uploadRelationsTableName,
            Key: {
                relationKey: relationKey,
            },
        }));

        const currentUploadId = relation.Item?.currentUploadId as string | undefined;
        let previousUpload: UploadRecord | undefined;

        if (currentUploadId && currentUploadId !== upload.uploadId) {
            const previousUploadResponse = await db.send(new GetCommand({
                TableName: uploadsTableName,
                Key: {
                    uploadId: currentUploadId,
                },
            }));

            previousUpload = previousUploadResponse.Item as UploadRecord | undefined;
        }

        await db.send(new PutCommand({
            TableName: uploadRelationsTableName,
            Item: {
                relationKey: relationKey,
                currentUploadId: upload.uploadId,
                currentFinalKey: finalKey,
                currentFormats: formats ?? [],
                updatedAt,
                previousUploadId: previousUpload?.uploadId,
            },
        }));

        return {
            ...event,
            uploadId: upload.uploadId,
            status,
            previousUpload,
        };
    }

    return {
        ...event,
        uploadId: upload.uploadId,
        status,
    };
}
