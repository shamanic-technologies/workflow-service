import { PERSON_RELATIONSHIP_STRATEGY } from "../../src/lib/person-relationship.js";

/** A person judged and known to be none of the known tags, with no thread: what the writers assumed before the shared step. */
export const WHO_NOT_KNOWN = {
  state: "not_known",
  known: false,
  judged: true,
  tags: [],
  unsureTags: [],
  lines: ["Judged: nothing shows the brand knows this person yet."],
  hasThread: false,
  threadLines: [],
  olderMessagesOmitted: 0,
  eventLines: [],
  strategy: PERSON_RELATIONSHIP_STRATEGY,
};

type Main = (...args: unknown[]) => Promise<Record<string, unknown>>;

/** Runs a compose script whose LAST parameter is `who`: pads the positional arguments to `arity`, then appends it. */
export function withWho(main: Main, arity: number, who: unknown = WHO_NOT_KNOWN): Main {
  return (...args: unknown[]) => {
    const a = args.slice(0, arity);
    while (a.length < arity) a.push(undefined);
    return main(...a, who);
  };
}
