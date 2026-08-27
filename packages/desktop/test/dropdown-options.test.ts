import { describe, expect, it } from "vitest";
import {
	type AgentSettingValue,
	agentSettingOptionToDropdownOption,
	agentSettingValueKey,
} from "../src/renderer/settings-types";

const values: AgentSettingValue[] = [false, true, 0, -0, 1, -1, 1.5, "", "0", "-0", "1", "false", "true", "number:1"];

describe("dropdown option keys", () => {
	it("creates deterministic, collision-free keys across setting value types", () => {
		const keys = values.map(agentSettingValueKey);

		expect(new Set(keys).size).toBe(values.length);
		expect(agentSettingValueKey(false)).toBe("boolean:false");
		expect(agentSettingValueKey(0)).toBe("number:0");
		expect(agentSettingValueKey(-0)).toBe("number:-0");
		expect(agentSettingValueKey("0")).toBe("string:0");
		expect(values.map(agentSettingValueKey)).toEqual(keys);
	});

	it("preserves the original typed value while adapting setting options", () => {
		const options = values.map((value, index) =>
			agentSettingOptionToDropdownOption({
				value,
				label: `Option ${index}`,
				description: `Typed option ${index}`,
			}),
		);

		for (const [index, option] of options.entries()) {
			expect(Object.is(option.value, values[index])).toBe(true);
			expect(option.key).toBe(agentSettingValueKey(values[index]));
			expect(option.label).toBe(`Option ${index}`);
			expect(option.description).toBe(`Typed option ${index}`);
		}
	});
});
