import type { Signal, StrategyContext } from "../domain/types.js";

export interface Strategy {
  readonly name: string;
  generate(context: StrategyContext): Signal;
}
