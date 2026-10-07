import { ScanContext } from '../core/context';
import { GraphBuilder } from '../schema/builder';
import { FrameworkInfo } from '../schema/graph';

/** One framework found in the project (a repo can hold several). */
export type Detection = FrameworkInfo;

/**
 * A framework adapter. Adapters only read the project through the
 * ScanContext and only write through the GraphBuilder, so every adapter
 * produces the same normalized graph.
 */
export interface Adapter {
  id: string;
  name: string;
  language: string;
  /** Return one detection per app root found; empty when the framework is absent. */
  detect(ctx: ScanContext): Detection[];
  analyze(ctx: ScanContext, detection: Detection, graph: GraphBuilder): void;
}
