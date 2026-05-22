import * as fs from 'fs';
import * as zlib from 'zlib';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ITXT_CHUNK_TYPE = 'iTXt';
const IEND_CHUNK_TYPE = 'IEND';
const KM_PNG_KEYWORD = 'vscode-mindmap-km';

type PngChunk = {
	type: string;
	data: Buffer;
};

export type KmPngReadResult =
	| { kind: 'empty' }
	| { kind: 'invalid' }
	| { kind: 'missing' }
	| { kind: 'found'; json: string };

export function readKmPngJson(filePath: string): KmPngReadResult {
	try {
		if (!fs.existsSync(filePath) || fs.statSync(filePath).size === 0) {
			return { kind: 'empty' };
		}

		const pngBuffer = fs.readFileSync(filePath);
		if (!isPngBuffer(pngBuffer)) {
			return { kind: 'invalid' };
		}

		const chunks = parsePngChunks(pngBuffer);
		for (const chunk of chunks) {
			if (chunk.type !== ITXT_CHUNK_TYPE) {
				continue;
			}
			const text = parseITxtChunk(chunk.data);
			if (text && text.keyword === KM_PNG_KEYWORD) {
				return { kind: 'found', json: text.value };
			}
		}

		return { kind: 'missing' };
	} catch (error) {
		return { kind: 'invalid' };
	}
}

export function writeKmPngJson(pngBuffer: Buffer, json: string): Buffer {
	if (!isPngBuffer(pngBuffer)) {
		throw new Error('Invalid PNG buffer.');
	}

	const chunks = parsePngChunks(pngBuffer).filter((chunk) => !isKmPngTextChunk(chunk));
	const iendIndex = chunks.findIndex((chunk) => chunk.type === IEND_CHUNK_TYPE);
	if (iendIndex === -1) {
		throw new Error('PNG file is missing an IEND chunk.');
	}

	const outputChunks: Buffer[] = [PNG_SIGNATURE];
	const kmTextChunk = createPngChunk(ITXT_CHUNK_TYPE, createKmPngTextData(json));
	chunks.forEach((chunk, index) => {
		if (index === iendIndex) {
			outputChunks.push(kmTextChunk);
		}
		outputChunks.push(createPngChunk(chunk.type, chunk.data));
	});

	return Buffer.concat(outputChunks);
}

function isPngBuffer(buffer: Buffer): boolean {
	return buffer.length >= PNG_SIGNATURE.length && buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

function parsePngChunks(buffer: Buffer): PngChunk[] {
	if (!isPngBuffer(buffer)) {
		throw new Error('Invalid PNG signature.');
	}

	const chunks: PngChunk[] = [];
	let offset = PNG_SIGNATURE.length;
	let hasIend = false;

	while (offset < buffer.length) {
		if (offset + 12 > buffer.length) {
			throw new Error('Invalid PNG chunk header.');
		}

		const length = buffer.readUInt32BE(offset);
		const typeStart = offset + 4;
		const dataStart = offset + 8;
		const dataEnd = dataStart + length;
		const crcEnd = dataEnd + 4;

		if (crcEnd > buffer.length) {
			throw new Error('Invalid PNG chunk length.');
		}

		const type = buffer.toString('latin1', typeStart, typeStart + 4);
		const data = buffer.subarray(dataStart, dataEnd);
		const expectedCrc = buffer.readUInt32BE(dataEnd);
		const actualCrc = crc32(Buffer.concat([Buffer.from(type, 'latin1'), data]));
		if (expectedCrc !== actualCrc) {
			throw new Error(`Invalid PNG CRC for ${type}.`);
		}

		chunks.push({ type, data });
		offset = crcEnd;

		if (type === IEND_CHUNK_TYPE) {
			hasIend = true;
			break;
		}
	}

	if (!hasIend) {
		throw new Error('PNG file is missing an IEND chunk.');
	}

	return chunks;
}

function isKmPngTextChunk(chunk: PngChunk): boolean {
	if (chunk.type !== ITXT_CHUNK_TYPE) {
		return false;
	}
	const text = parseITxtChunk(chunk.data);
	return text?.keyword === KM_PNG_KEYWORD;
}

function createKmPngTextData(json: string): Buffer {
	const compressedJson = zlib.deflateSync(Buffer.from(json, 'utf8'));
	return Buffer.concat([
		Buffer.from(KM_PNG_KEYWORD, 'latin1'),
		Buffer.from([0x00]),
		Buffer.from([0x01]),
		Buffer.from([0x00]),
		Buffer.from([0x00]),
		Buffer.from([0x00]),
		compressedJson,
	]);
}

function parseITxtChunk(data: Buffer): { keyword: string; value: string } | undefined {
	const keywordEnd = data.indexOf(0x00);
	if (keywordEnd < 0) {
		return undefined;
	}

	const keyword = data.toString('latin1', 0, keywordEnd);
	let offset = keywordEnd + 1;
	if (offset + 2 > data.length) {
		return undefined;
	}

	const compressionFlag = data[offset];
	offset += 1;
	const compressionMethod = data[offset];
	offset += 1;

	const languageEnd = data.indexOf(0x00, offset);
	if (languageEnd < 0) {
		return undefined;
	}
	offset = languageEnd + 1;

	const translatedKeywordEnd = data.indexOf(0x00, offset);
	if (translatedKeywordEnd < 0) {
		return undefined;
	}
	offset = translatedKeywordEnd + 1;

	const textBuffer = data.subarray(offset);
	if (compressionFlag === 0x01) {
		if (compressionMethod !== 0x00) {
			return undefined;
		}
		return { keyword, value: zlib.inflateSync(textBuffer).toString('utf8') };
	}

	if (compressionFlag === 0x00) {
		return { keyword, value: textBuffer.toString('utf8') };
	}

	return undefined;
}

function createPngChunk(type: string, data: Buffer): Buffer {
	const lengthBuffer = Buffer.alloc(4);
	lengthBuffer.writeUInt32BE(data.length, 0);

	const typeBuffer = Buffer.from(type, 'latin1');
	const crcBuffer = Buffer.alloc(4);
	crcBuffer.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])), 0);

	return Buffer.concat([lengthBuffer, typeBuffer, data, crcBuffer]);
}

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let index = 0; index < table.length; index++) {
		let value = index;
		for (let bit = 0; bit < 8; bit++) {
			value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
		}
		table[index] = value >>> 0;
	}
	return table;
})();

function crc32(buffer: Buffer): number {
	let crc = 0xffffffff;
	for (const byte of buffer) {
		crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
	}
	return (crc ^ 0xffffffff) >>> 0;
}
