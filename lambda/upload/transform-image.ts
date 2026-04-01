import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import sharp from "sharp";

const s3 = new S3Client({});
const uploadBucket = process.env.UPLOAD_BUCKET!;

export async function handler(event: { key: string; finalKey: string; mime: string; isValid: boolean }) {
    const object = await s3.send(new GetObjectCommand({
        Bucket: uploadBucket,
        Key: event.finalKey,
    }));

    if (!object.Body) {
        throw new Error("Failed to read uploaded object");
    }

    const buffer = await object.Body.transformToByteArray();
    const metadata = await sharp(buffer).metadata();

    async function createVariant(width: number, prefix: string) {
        const transformed = await sharp(buffer)
            .resize({ width, withoutEnlargement: true })
            .webp({ quality: 75 })
            .toBuffer({ resolveWithObject: true });

        const parts = event.finalKey.split("/");
        const fileName = parts.pop()!;
        const newKey = [...parts, `${prefix}-${fileName}`].join("/");

        await s3.send(new PutObjectCommand({
            Bucket: uploadBucket,
            Key: newKey,
            Body: transformed.data,
            ContentType: "image/webp",
        }));

        return {
            key: newKey,
            width: transformed.info.width,
            height: transformed.info.height,
            size: transformed.info.size,
            mime: "image/webp",
        };
    }

    const formats = await Promise.all([
        createVariant(1000, "large"),
        createVariant(500, "small"),
    ]);

    return {
        ...event,
        width: metadata.width,
        height: metadata.height,
        formats,
    };
}