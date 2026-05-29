/** Complexity router: classify into direct / single / orchestrate. Rules-first, <1ms. */
export type Mode = 'direct' | 'single' | 'orchestrate';
/** Classify `goal` into direct (greeting/question), single (one agent+tool), or orchestrate (multi-step plan). */
export declare function classify(goal: string): Mode;
/** Pick one agent by keyword routing. Falls back to rain. */
export declare function pickAgentForKey(goal: string, available: Set<string>): string;
