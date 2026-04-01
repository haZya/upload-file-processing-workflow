import type { APIGatewayEventRequestContextV2, APIGatewayProxyEventV2WithRequestContext } from "aws-lambda";
import { S3Client } from "@aws-sdk/client-s3";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";

const s3 = new S3Client({});

const stagingBucketName = process.env.STAGING_UPLOAD_BUCKET_NAME;

if (!stagingBucketName) {
    throw new Error("STAGING_UPLOAD_BUCKET_NAME environment variable is required");
}

const stagingBucket = stagingBucketName;

interface UploadFileRequest {
    fileName: string;
    contentType?: string;
}

interface GeneratePresignedPostRequest {
    files: UploadFileRequest[];
    relationKey: string;
}

interface UploadResponse {
    key: string;
    url: string;
    fields: Record<string, string>;
}

type RequestContextWithAuthorizer = APIGatewayEventRequestContextV2 & {
    authorizer?: {
        lambda?: { userId?: string; userSub?: string };
        jwt?: { claims?: Record<string, string> };
    };
};

function getUserId(event: APIGatewayProxyEventV2WithRequestContext<RequestContextWithAuthorizer>) {
    const lambdaAuthorizer = event.requestContext.authorizer?.lambda;
    const jwtClaims = event.requestContext.authorizer?.jwt?.claims;

    return lambdaAuthorizer?.userId
        ?? lambdaAuthorizer?.userSub
        ?? jwtClaims?.sub
        ?? "demo-user-sub";
}

function parseRequestBody(event: APIGatewayProxyEventV2WithRequestContext<RequestContextWithAuthorizer>): GeneratePresignedPostRequest {
    if (!event.body) {
        throw new Error("Request body is required");
    }

    const body = JSON.parse(event.body) as Partial<GeneratePresignedPostRequest>;

    if (!body.relationKey) {
        throw new Error("relationKey is required");
    }

    if (!Array.isArray(body.files) || body.files.length === 0) {
        throw new Error("files must be a non-empty array");
    }

    return {
        relationKey: body.relationKey,
        files: body.files,
    };
}

export async function handler(event: APIGatewayProxyEventV2WithRequestContext<RequestContextWithAuthorizer>) {
    try {
        const { files, relationKey } = parseRequestBody(event);
        const userId = getUserId(event);
        const uploads: UploadResponse[] = [];

        for (const { fileName, contentType } of files) {
            const safeName = fileName.replace(/\.{2,}/g, ".").replace(/[^\w.-]/g, "_");
            const timestamp = Date.now();
            const key = `uploads/${userId}/${timestamp}/${safeName}`;

            const { url, fields } = await createPresignedPost(s3, {
                Bucket: stagingBucket,
                Key: key,
                Conditions: [
                    ["content-length-range", 0, 100 * 1024 * 1024],
                    ["starts-with", "$Content-Type", contentType ?? ""],
                    ["eq", "$x-amz-meta-relation-key", relationKey],
                    ["eq", "$x-amz-meta-author-id", userId],
                ],
                Fields: {
                    ...(contentType ? { "Content-Type": contentType } : {}),
                    "x-amz-meta-relation-key": relationKey,
                    "x-amz-meta-author-id": userId,
                },
                Expires: 600,
            });

            uploads.push({ key, url, fields });
        }

        return {
            statusCode: 200,
            body: JSON.stringify({ uploads }),
        };
    }
    catch (error) {
        console.error("Failed to generate presigned post", error);

        return {
            statusCode: 400,
            body: JSON.stringify({ message: "Failed to generate presigned post" }),
        };
    }
}
