/**
 * Minimal multipart/form-data parser.
 *
 * Handles the subset needed for image uploads: binary file fields and
 * simple string fields. Not a full RFC 7578 implementation — no nested
 * multipart, no quoted-printable, no transfer encodings beyond identity.
 */

export interface MultipartField {
  name: string;
  filename?: string;
  contentType?: string;
  data: Buffer;
}

/** Extract the boundary from a multipart Content-Type header. */
export function parseBoundary(contentType: string | undefined): string | null {
  if (!contentType) return null;
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  if (!match) return null;
  return (match[1] ?? match[2]).trim();
}

/** Parse a multipart body and return all fields. Throws on malformed input. */
export function parseMultipart(body: Buffer, boundary: string): MultipartField[] {
  const delim = Buffer.from(`--${boundary}`);
  const crlf = Buffer.from("\r\n");
  const fields: MultipartField[] = [];

  let pos = body.indexOf(delim);
  if (pos === -1) throw new Error("boundary not found");

  while (pos < body.length) {
    pos += delim.length;
    // End-of-multipart marker: "--"
    if (body[pos] === 0x2d && body[pos + 1] === 0x2d) break;
    if (body[pos] === 0x0d && body[pos + 1] === 0x0a) pos += 2;

    const headersEnd = body.indexOf(Buffer.from("\r\n\r\n"), pos);
    if (headersEnd === -1) throw new Error("malformed headers");

    const headerStr = body.slice(pos, headersEnd).toString("utf-8");
    const field: Partial<MultipartField> = {};
    for (const line of headerStr.split("\r\n")) {
      const idx = line.indexOf(":");
      if (idx === -1) continue;
      const name = line.slice(0, idx).trim().toLowerCase();
      const value = line.slice(idx + 1).trim();
      if (name === "content-disposition") {
        const nameMatch = value.match(/name="([^"]+)"/);
        const filenameMatch = value.match(/filename="([^"]*)"/);
        if (nameMatch) field.name = nameMatch[1];
        if (filenameMatch) field.filename = filenameMatch[1];
      } else if (name === "content-type") {
        field.contentType = value;
      }
    }

    const dataStart = headersEnd + 4;
    const nextDelim = body.indexOf(delim, dataStart);
    if (nextDelim === -1) throw new Error("missing closing boundary");
    // Strip trailing CRLF before the next delimiter
    const dataEnd = body.slice(nextDelim - 2, nextDelim).equals(crlf) ? nextDelim - 2 : nextDelim;

    if (field.name) {
      fields.push({
        name: field.name,
        filename: field.filename,
        contentType: field.contentType,
        data: body.slice(dataStart, dataEnd),
      });
    }
    pos = nextDelim;
  }

  return fields;
}
