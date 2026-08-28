import * as path from "node:path";
import sharp from "sharp";

const desktopResources = path.resolve(import.meta.dir, "../resources");
const lightArtworkPath = path.join(desktopResources, "titlebar-logo.png");
const iconPngPath = path.join(desktopResources, "icon.png");
const iconIcoPath = path.join(desktopResources, "icon.ico");
const iconIcnsPath = path.join(desktopResources, "icon.icns");

const sourceBuffer = Buffer.from(await Bun.file(lightArtworkPath).arrayBuffer());

// 1. Generate master macOS squircle icon.png (1024x1024 with 824x824 body and drop shadow)
const artworkBuffer = await sharp(sourceBuffer).resize(824, 824, { fit: "cover" }).png().toBuffer();

const artworkBase64 = artworkBuffer.toString("base64");

const squircleSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <filter id="macShadow" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="8" stdDeviation="14" flood-color="#000000" flood-opacity="0.32" />
      <feDropShadow dx="0" dy="24" stdDeviation="28" flood-color="#000000" flood-opacity="0.45" />
    </filter>
    <clipPath id="squircleClip">
      <rect x="100" y="100" width="824" height="824" rx="185" ry="185" />
    </clipPath>
    <linearGradient id="bevelStroke" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.22" />
      <stop offset="40%" stop-color="#ffffff" stop-opacity="0.06" />
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0.0" />
    </linearGradient>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="185" ry="185" fill="#0c0204" filter="url(#macShadow)" />
  <g clip-path="url(#squircleClip)">
    <image x="100" y="100" width="824" height="824" href="data:image/png;base64,${artworkBase64}" preserveAspectRatio="xMidYMid slice" />
  </g>
  <rect x="100.5" y="100.5" width="823" height="823" rx="184.5" ry="184.5" fill="none" stroke="url(#bevelStroke)" stroke-width="1.5" pointer-events="none" />
</svg>`;

const masterPngBuffer = await sharp(Buffer.from(squircleSvg)).png({ quality: 100, compressionLevel: 9 }).toBuffer();

await Bun.write(iconPngPath, masterPngBuffer);

// 2. Generate a modern PNG-backed macOS .icns on every host.
const icnsSpecs = [
	{ type: "icp4", size: 16 },
	{ type: "ic11", size: 32 },
	{ type: "icp5", size: 32 },
	{ type: "ic12", size: 64 },
	{ type: "icp6", size: 64 },
	{ type: "ic07", size: 128 },
	{ type: "ic13", size: 256 },
	{ type: "ic08", size: 256 },
	{ type: "ic14", size: 512 },
	{ type: "ic09", size: 512 },
	{ type: "ic10", size: 1024 },
] as const;
const icnsEntries = await Promise.all(
	icnsSpecs.map(async ({ type, size }) => {
		const png = await sharp(masterPngBuffer)
			.resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
			.png({ quality: 100, compressionLevel: 9 })
			.toBuffer();
		const entry = Buffer.alloc(8 + png.length);
		entry.write(type, 0, 4, "ascii");
		entry.writeUInt32BE(entry.length, 4);
		png.copy(entry, 8);
		return entry;
	}),
);
const icnsHeader = Buffer.alloc(8);
icnsHeader.write("icns", 0, 4, "ascii");
icnsHeader.writeUInt32BE(icnsHeader.length + icnsEntries.reduce((sum, entry) => sum + entry.length, 0), 4);
await Bun.write(iconIcnsPath, Buffer.concat([icnsHeader, ...icnsEntries]));

// 3. Generate multi-resolution Windows icon.ico
const sizes = [256, 128, 64, 48, 32, 16];
const pngBuffers = await Promise.all(
	sizes.map(size =>
		sharp(masterPngBuffer)
			.resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
			.png({ quality: 100, compressionLevel: 9 })
			.toBuffer(),
	),
);

const count = sizes.length;
const headerSize = 6;
const dirEntrySize = 16;
const dirSize = count * dirEntrySize;
let offset = headerSize + dirSize;

const icoHeader = Buffer.alloc(headerSize);
icoHeader.writeUInt16LE(0, 0);
icoHeader.writeUInt16LE(1, 2);
icoHeader.writeUInt16LE(count, 4);

const entries: Buffer[] = [];
for (let i = 0; i < count; i++) {
	const s = sizes[i];
	const buf = pngBuffers[i];
	const entry = Buffer.alloc(dirEntrySize);
	entry.writeUInt8(s === 256 ? 0 : s, 0);
	entry.writeUInt8(s === 256 ? 0 : s, 1);
	entry.writeUInt8(0, 2);
	entry.writeUInt8(0, 3);
	entry.writeUInt16LE(1, 4);
	entry.writeUInt16LE(32, 6);
	entry.writeUInt32LE(buf.length, 8);
	entry.writeUInt32LE(offset, 12);
	entries.push(entry);
	offset += buf.length;
}

const finalIco = Buffer.concat([icoHeader, ...entries, ...pngBuffers]);
await Bun.write(iconIcoPath, finalIco);

process.stdout.write("Generated Gradivus squircle icon.png, icon.ico, and icon.icns\n");
