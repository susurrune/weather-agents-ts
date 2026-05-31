/** Pipeline templates — predefined multi-agent DAGs. Rule-only match (<1µs). */
import { Task } from './agent.js';
export interface PipelineStep {
    id: string;
    agent: string;
    descriptionTemplate: string;
    dependsOn: string[];
}
export interface Pipeline {
    name: string;
    triggers: string[];
    steps: PipelineStep[];
    requireRegex: string[];
}
/** Return the first matching pipeline, or null. Case-insensitive substring + regex. */
export declare function matchPipeline(goal: string): Pipeline | null;
/** Materialize a pipeline into runtime Task objects (full DAG). */
export declare function buildTasksFromPipeline(pipeline: Pipeline, goal: string): Task[];
/** For CLI / debug introspection. */
export declare function listPipelines(): Array<{
    name: string;
    triggers: string[];
    steps: Array<{
        id: string;
        agent: string;
        dependsOn: string[];
    }>;
}>;
