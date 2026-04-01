import { UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { db, uploadsTableName } from "./utils/uploads-table";

export async function handler(event: {
    uploadId: string;
    key: string;
    finalKey: string;
    mime: string;
    width?: number;
    height?: number;
    formats?: Array<{ key: string; width: number; height: number; size: number; mime: string }>;
}) {
    const metadataSavedAt = new Date().toISOString();

    await db.send(new UpdateCommand({
        TableName: uploadsTableName,
        Key: {
            uploadId: event.uploadId,
        },
        UpdateExpression: "SET finalKey = :finalKey, mime = :mime, width = :width, height = :height, formats = :formats, metadataSavedAt = :metadataSavedAt, updatedAt = :updatedAt",
        ExpressionAttributeValues: {
            ":finalKey": event.finalKey,
            ":mime": event.mime,
            ":width": event.width ?? null,
            ":height": event.height ?? null,
            ":formats": event.formats ?? [],
            ":metadataSavedAt": metadataSavedAt,
            ":updatedAt": metadataSavedAt,
        },
    }));

    return {
        ...event,
        metadataSavedAt,
    };
}
