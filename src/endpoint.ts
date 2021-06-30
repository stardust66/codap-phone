import { IframePhoneRpcEndpoint } from "iframe-phone";
import {
  CodapPhone,
  CodapResponse,
  CodapActions,
  CodapInitiatedCommand,
  CodapInitiatedResource,
  DocumentChangeOperations,
  ContextChangeOperation,
} from "./types";
import {
  callUpdateListenersForContext,
  callAllContextListeners,
} from "./listeners";
import * as Cache from "./cache";

export const phone: CodapPhone = new IframePhoneRpcEndpoint(
  codapRequestHandler,
  "data-interactive",
  window.parent,
  null,
  null
);

export const mutatingOperations = [
  ContextChangeOperation.UpdateCases,
  ContextChangeOperation.CreateCases,
  ContextChangeOperation.DeleteCases,
  ContextChangeOperation.MoveCases,
  ContextChangeOperation.CreateAttribute,
  ContextChangeOperation.UpdateAttribute,
  ContextChangeOperation.DeleteAttribute,
  ContextChangeOperation.MoveAttribute,
  ContextChangeOperation.UpdateCollection,
  ContextChangeOperation.CreateCollection,
  ContextChangeOperation.DeleteCollection,
  ContextChangeOperation.DependentCases,
  ContextChangeOperation.HideAttribute,
  ContextChangeOperation.UnhideAttribute,
];

/**
 * Catch notifications from CODAP and call appropriate listeners
 */
function codapRequestHandler(
  command: CodapInitiatedCommand,
  callback: (r: CodapResponse) => void
): void {
  if (command.action !== CodapActions.Notify) {
    callback({ success: true });
    return;
  }

  if (
    command.resource === CodapInitiatedResource.DocumentChangeNotice &&
    command.values.operation ===
      DocumentChangeOperations.DataContextCountChanged
  ) {
    callAllContextListeners();
    callback({ success: true });
    return;
  }

  if (
    command.resource.startsWith(
      CodapInitiatedResource.DataContextChangeNotice
    ) &&
    Array.isArray(command.values)
  ) {
    // FIXME: Using flags here we can process all notifications in the list
    // without needlessly updating for each one, but this doesn't seem like
    // the most elegant solution.
    let contextUpdate = false;
    let contextListUpdate = false;

    // Context name is between the first pair of brackets
    const contextName = command.resource.slice(
      command.resource.search("\\[") + 1,
      command.resource.length - 1
    );

    for (const value of command.values) {
      contextUpdate =
        contextUpdate || mutatingOperations.includes(value.operation);
      contextListUpdate =
        contextListUpdate ||
        value.operation === ContextChangeOperation.UpdateContext;

      // Check for case update or deletion and invalidate case cache
      if (
        value.operation === ContextChangeOperation.DeleteCases ||
        value.operation === ContextChangeOperation.UpdateCases
      ) {
        const caseIDs = value.result?.caseIDs;
        if (Array.isArray(caseIDs)) {
          caseIDs.map(Cache.invalidateCase);
        }
      }
    }

    if (contextUpdate) {
      Cache.invalidateContext(contextName);
      callUpdateListenersForContext(contextName);
    }

    if (contextListUpdate) {
      callAllContextListeners();
    }
  }

  callback({ success: true });
}
