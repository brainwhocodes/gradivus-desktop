const PROMPT_ATTACHMENT_DISPLAY_ENVELOPE =
	/(\[(?:Document|Prompt|Image) A\d+: ("(?:[^"\\]|\\.)*")\])\r?\n(?:Prompt text:\s+@(?:"[^"\r\n]*gradivus-prompt-[^"\r\n]*"|'[^'\r\n]*gradivus-prompt-[^'\r\n]*')\. Read the referenced UTF-8 text at this exact position in the request\.|File\s+\2:\s+@(?:"[^"\r\n]*gradivus-prompt-[^"\r\n]*"|'[^'\r\n]*gradivus-prompt-[^'\r\n]*')\. Read this attachment as needed\.|Image\s+\2 is attached to this message\.)/g;

/** Remove generated attachment transport envelopes while preserving their visible reference chips. */
export function promptAttachmentDisplayText(value: string): string {
	return value.replace(PROMPT_ATTACHMENT_DISPLAY_ENVELOPE, "$1");
}
