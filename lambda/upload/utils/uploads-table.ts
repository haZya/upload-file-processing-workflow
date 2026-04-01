import { randomUUID } from "node:crypto";
import type { HeadObjectCommandOutput } from "@aws-sdk/client-s3";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";

export interface UploadStatus {
    isSuccess: boolean;
    name: string;
    message: string;
}

export interface UploadFormat {
    key: string;
    width: number;
    height: number;
    size: number;
    mime: string;
}

export interface UploadRecord {
    uploadId: string;
    stagingKey: string;
    bucket?: string;
    finalKey?: string;
    relationKey?: string;
    authorSubId?: string;
    formats?: UploadFormat[];
}

export interface UploadContext {
    uploadId: string;
    authorSubId?: string;
    relationKey?: string;
}

export const db = DynamoDBDocumentClient.from(new DynamoDBClient({}));

export const uploadsTableName = process.env.UPLOADS_TABLE_NAME;
export const uploadRelationsTableName = process.env.UPLOAD_RELATIONS_TABLE_NAME;

if (!uploadsTableName) {
    throw new Error("UPLOADS_TABLE_NAME environment variable is required");
}

if (!uploadRelationsTableName) {
    throw new Error("UPLOAD_RELATIONS_TABLE_NAME environment variable is required");
}

export async function findLatestUploadByStagingKey(stagingKey: string) {
    const response = await db.send(new QueryCommand({
        TableName: uploadsTableName,
        IndexName: "ByStagingKey",
        KeyConditionExpression: "stagingKey = :stagingKey",
        ExpressionAttributeValues: {
            ":stagingKey": stagingKey,
        },
        ScanIndexForward: false,
        Limit: 1,
    }));

    return response.Items?.[0] as UploadRecord | undefined;
}

export function getUploadContext(head: HeadObjectCommandOutput, upload?: UploadRecord): UploadContext {
    const metadata = head.Metadata ?? {};
    const relationKey = upload?.relationKey ?? metadata["relation-key"];

    return {
        uploadId: upload?.uploadId ?? randomUUID(),
        authorSubId: upload?.authorSubId ?? metadata["author-id"],
        relationKey,
    };
}

export async function ensureUploadRecord(params: {
    bucket: string;
    key: string;
    head: HeadObjectCommandOutput;
    upload?: UploadRecord;
    pendingMessage: string;
}) {
    const { bucket, key, head, upload, pendingMessage } = params;
    const context = getUploadContext(head, upload);

    if (upload) {
        return context;
    }

    const now = new Date().toISOString();

    await db.send(new PutCommand({
        TableName: uploadsTableName,
        Item: {
            uploadId: context.uploadId,
            stagingKey: key,
            bucket,
            createdAt: now,
            updatedAt: now,
            status: {
                isSuccess: false,
                name: "PENDING_SCAN",
                message: pendingMessage,
            },
            ...(head.ContentType ? { contentType: head.ContentType } : {}),
            ...(typeof head.ContentLength === "number" ? { contentLength: head.ContentLength } : {}),
            ...(head.ETag ? { eTag: head.ETag } : {}),
            ...(context.authorSubId ? { authorSubId: context.authorSubId } : {}),
            ...(context.relationKey ? { relationKey: context.relationKey } : {}),
        },
        ConditionExpression: "attribute_not_exists(uploadId)",
    }));

    return context;
}
