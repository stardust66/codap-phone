import { phone } from "./endpoint";
import {
  Dataset,
  CodapComponentType,
  CodapResource,
  CodapActions,
  CodapResponse,
  CodapRequest,
  GetContextResponse,
  GetCasesResponse,
  GetCaseResponse,
  ReturnedCase,
  Collection,
  DataContext,
  CodapListResource,
  CodapIdentifyingInfo,
  CaseTable,
  GetDataListResponse,
} from "./types";
import {
  resourceFromContext,
  itemFromContext,
  resourceFromComponent,
  collectionListFromContext,
  attributeListFromCollection,
  caseById,
  allCasesWithSearch,
} from "./resource";
import {
  fillCollectionWithDefaults,
  collectionsEqual,
  uniqueName,
  getNewName,
  normalizeDataContext,
} from "./util";
import * as Actions from "./actions";
import * as Cache from "./cache";

export * from "./types";
export {
  addNewContextListener,
  removeNewContextListener,
  addContextUpdateListener,
  removeContextUpdateListener,
} from "./listeners";

/**
 * Set up the plugin window with the given title, width, and height.
 *
 * @param title - Title of the plugin window
 * @param width - Width of the plugin window, in pixels
 * @param height - Height of the plugin window, in pixels
 */
export async function initializePlugin(
  title: string,
  width: number,
  height: number
): Promise<void> {
  return new Promise<void>((resolve, reject) =>
    phone.call(
      {
        action: CodapActions.Update,
        resource: CodapResource.InteractiveFrame,
        values: {
          title,
          dimensions: {
            width,
            height,
          },
        },
      },
      (response) => {
        if (response && response.success) {
          resolve();
        } else {
          reject(new Error("Failed to update CODAP interactive frame"));
        }
      }
    )
  );
}

/**
 * Make a bundled request to CODAP with multiple calls
 *
 * @param requests - Array of CodapRequests to send
 * @returns A promise of an array of responses that correspond with the requests
 */
export function callMultiple(
  requests: CodapRequest[]
): Promise<CodapResponse[]> {
  return new Promise<CodapResponse[]>((resolve) => {
    phone.call(requests, (responses) => resolve(responses));
  });
}

/**
 * Get identifying information (name, title) for all existing data contexts.
 */
export function getAllDataContexts(): Promise<CodapIdentifyingInfo[]> {
  return new Promise<CodapIdentifyingInfo[]>((resolve, reject) =>
    phone.call(
      {
        action: CodapActions.Get,
        resource: CodapResource.DataContextList,
      },
      (response) => {
        if (Array.isArray(response.values)) {
          resolve(response.values);
        } else {
          reject(new Error("Failed to get data contexts."));
        }
      }
    )
  );
}

/**
 * Get all CODAP collections for the given context.
 *
 * @param context - Name of the context
 * @returns A promise of a list of identifying information of the collections
 * in the given context.
 */
export function getAllCollections(
  context: string
): Promise<CodapIdentifyingInfo[]> {
  return new Promise<CodapIdentifyingInfo[]>((resolve, reject) =>
    phone.call(
      {
        action: CodapActions.Get,
        resource: collectionListFromContext(context),
      },
      (response: GetDataListResponse) => {
        if (response.success) {
          resolve(response.values);
        } else {
          reject(new Error("Failed to get collections."));
        }
      }
    )
  );
}

/**
 * Get a CODAP case in the context `context` with the id `id`.
 *
 * @param context - Context in which to retrieve the case
 * @param id - ID of the case to retrieve
 * @returns A promise of the specified case.
 */
function getCaseById(context: string, id: number): Promise<ReturnedCase> {
  return new Promise<ReturnedCase>((resolve, reject) => {
    const cached = Cache.getCase(id);
    if (cached !== undefined) {
      resolve(cached);
      return;
    }
    phone.call(
      {
        action: CodapActions.Get,
        resource: caseById(context, id),
      },
      (response: GetCaseResponse) => {
        if (response.success) {
          const result = response.values.case;
          Cache.setCase(context, id, result);
          resolve(result);
        } else {
          reject(new Error(`Failed to get case in ${context} with id ${id}`));
        }
      }
    );
  });
}

/**
 * Get all attributes for a particular data context.
 *
 * @param context - Name of the data context
 * @returns A promise of an array of identifying information for the attributes
 */
export async function getAllAttributes(
  context: string
): Promise<CodapIdentifyingInfo[]> {
  // Get the name (as a string) of each collection in the context
  const collections = (await getAllCollections(context)).map(
    (collection) => collection.name
  );

  // Make a request to get the attributes for each collection
  const promises = collections.map(
    (collectionName) =>
      new Promise<CodapIdentifyingInfo[]>((resolve, reject) =>
        phone.call(
          {
            action: CodapActions.Get,
            resource: attributeListFromCollection(context, collectionName),
          },
          (response: GetDataListResponse) => {
            if (response.success) {
              resolve(response.values);
            } else {
              reject(new Error("Failed to get attributes."));
            }
          }
        )
      )
  );

  // Wait for all promises to return
  const attributes = await Promise.all(promises);

  // flatten and return the set of attributes
  // return attributes.reduce((acc, elt) => [...acc, ...elt]);
  return attributes.flat();
}

/**
 * Get data from a data context.
 *
 * @param context - The name of the data context
 * @returns An array of the data rows where each row is an object
 */
export async function getDataFromContext(
  context: string
): Promise<Record<string, unknown>[]> {
  const cached = Cache.getRecords(context);
  if (cached !== undefined) {
    return cached;
  }

  async function dataItemFromChildCase(
    c: ReturnedCase
  ): Promise<Record<string, unknown>> {
    if (c.parent === null || c.parent === undefined) {
      return c.values;
    }
    const parent = await getCaseById(context, c.parent);
    const results = {
      ...c.values,
      ...(await dataItemFromChildCase(parent)),
    };

    return results;
  }

  const collections = (await getDataContext(context)).collections;
  const childCollection = collections[collections.length - 1];

  return new Promise<Record<string, unknown>[]>((resolve, reject) =>
    phone.call(
      {
        action: CodapActions.Get,
        resource: allCasesWithSearch(context, childCollection.name),
      },
      async (response: GetCasesResponse) => {
        if (response.success) {
          const records = await Promise.all(
            response.values.map(dataItemFromChildCase)
          );
          Cache.setRecords(context, records);
          resolve(records);
        } else {
          reject(new Error("Failed to get data items"));
        }
      }
    )
  );
}

/**
 * Get data context object.
 *
 * @param contextName - The name of the desired data context
 * @returns A promise of the desired data context.
 */
export function getDataContext(contextName: string): Promise<DataContext> {
  return new Promise<DataContext>((resolve, reject) => {
    const cached = Cache.getContext(contextName);
    if (cached !== undefined) {
      resolve(cached);
      return;
    }
    phone.call(
      {
        action: CodapActions.Get,
        resource: resourceFromContext(contextName),
      },
      (response: GetContextResponse) => {
        if (response.success) {
          const context = normalizeDataContext(response.values);
          Cache.setContext(contextName, context);
          resolve(context);
        } else {
          reject(new Error(`Failed to get context ${contextName}`));
        }
      }
    );
  });
}

/**
 * Create a data context.
 *
 * @param name - The name of the new data context
 * @param collections - The collections in the new data context
 * @param title - The title of the new data context
 * @returns A promise of the identifying information of the newly created data
 * context
 */
async function createDataContext(
  name: string,
  collections: Collection[],
  title?: string
): Promise<CodapIdentifyingInfo> {
  return new Promise<CodapIdentifyingInfo>((resolve, reject) =>
    phone.call(
      {
        action: CodapActions.Create,
        resource: CodapResource.DataContext,
        values: {
          name: name,
          title: title !== undefined ? title : name,
          collections: collections,
        },
      },
      (response) => {
        if (response.success) {
          resolve(response.values);
        } else {
          reject(new Error("Failed to create dataset"));
        }
      }
    )
  );
}

/**
 * Create a data context by providing a dataset object.
 *
 * @param dataset - The given dataset object
 * @param name - The name of the new data context
 * @param title - The title of the new data context
 * @returns A promise of the identifying information of the newly created data
 * context
 */
export async function createContextWithDataset(
  dataset: Dataset,
  name: string,
  title?: string
): Promise<CodapIdentifyingInfo> {
  const newDatasetDescription = await createDataContext(
    name,
    dataset.collections,
    title
  );

  await insertDataItems(newDatasetDescription.name, dataset.records);
  return newDatasetDescription;
}

/**
 * Insert data items into a data context.
 *
 * @param contextName - The name of the target data context
 * @param data - The items to insert
 */
export function insertDataItems(
  contextName: string,
  data: Record<string, unknown>[]
): Promise<void> {
  return new Promise<void>((resolve, reject) =>
    phone.call(
      {
        action: CodapActions.Create,
        resource: itemFromContext(contextName),
        values: data,
      },
      (response) => {
        if (response.success) {
          resolve();
        } else {
          reject(new Error("Failed to create dataset with data"));
        }
      }
    )
  );
}

/**
 * Update context with dataset object.
 *
 * @param contextName - The name of the context to update
 * @param dataset - The dataset object with which to update the context
 */
export async function updateContextWithDataSet(
  contextName: string,
  dataset: Dataset
): Promise<void> {
  const context = await getDataContext(contextName);
  const requests = [];

  for (const collection of context.collections) {
    requests.push(Actions.deleteAllCases(contextName, collection.name));
  }

  const normalizedCollections = dataset.collections.map(
    fillCollectionWithDefaults
  );

  if (!collectionsEqual(context.collections, normalizedCollections)) {
    const concatNames = (nameAcc: string, collection: Collection) =>
      nameAcc + collection.name;
    const uniqueName =
      context.collections.reduce(concatNames, "") +
      dataset.collections.reduce(concatNames, "");

    // Create placeholder empty collection, since data contexts must have at least
    // one collection
    requests.push(
      Actions.createCollections(contextName, [
        {
          name: uniqueName,
          labels: {},
        },
      ])
    );

    // Delete old collections
    for (const collection of context.collections) {
      requests.push(Actions.deleteCollection(contextName, collection.name));
    }

    // Insert new collections and delete placeholder
    requests.push(Actions.createCollections(contextName, dataset.collections));
    requests.push(Actions.deleteCollection(contextName, uniqueName));
  }

  requests.push(Actions.insertDataItems(contextName, dataset.records));

  const responses = await callMultiple(requests);
  for (const response of responses) {
    if (!response.success) {
      throw new Error(`Failed to update ${contextName}`);
    }
  }
}

/**
 * Create collections in a data context.
 *
 * @param context - The target data context
 * @param collections - The collections to create
 */
export function createCollections(
  context: string,
  collections: Collection[]
): Promise<void> {
  return new Promise<void>((resolve, reject) =>
    phone.call(Actions.createCollections(context, collections), (response) => {
      if (response.success) {
        resolve();
      } else {
        reject(new Error(`Failed to create collections in ${context}`));
      }
    })
  );
}

/**
 * Delete a collection in a data context.
 *
 * @param context - The name of the context in which the collection is located
 * @param collection - The name of the collection to delete
 */
export function deleteCollection(
  context: string,
  collection: string
): Promise<void> {
  return new Promise<void>((resolve, reject) =>
    phone.call(Actions.deleteCollection(context, collection), (response) => {
      if (response.success) {
        resolve();
      } else {
        reject(
          new Error(`Failed to delete collection ${collection} in ${context}`)
        );
      }
    })
  );
}

/**
 * Delete all cases in the given collection.
 *
 * @param context - The name of the context in which the collection is located
 * @param collection - The name of the collection in which to delete all data
 */
export async function deleteAllCases(
  context: string,
  collection: string
): Promise<void> {
  return new Promise<void>((resolve, reject) =>
    phone.call(Actions.deleteAllCases(context, collection), (response) => {
      if (response.success) {
        resolve();
      } else {
        reject(new Error("Failed to delete all cases"));
      }
    })
  );
}

const DEFAULT_TABLE_WIDTH = 300;
const DEFAULT_TABLE_HEIGHT = 300;

/**
 * Create a table.
 *
 * @param name - The name of the new table
 * @param context - The data context for the new table
 * @returns A promise of the newly created table
 */
export async function createTable(
  name: string,
  context: string
): Promise<CaseTable> {
  return new Promise<CaseTable>((resolve, reject) =>
    phone.call(
      {
        action: CodapActions.Create,
        resource: CodapResource.Component,
        values: {
          type: CodapComponentType.CaseTable,
          name: name,
          dimensions: {
            width: DEFAULT_TABLE_WIDTH,
            height: DEFAULT_TABLE_HEIGHT,
          },
          dataContext: context,
        },
      },
      (response) => {
        if (response.success) {
          resolve(response.values);
        } else {
          reject(new Error("Failed to create table"));
        }
      }
    )
  );
}

const TEXT_WIDTH = 100;
const TEXT_HEIGHT = 100;

/**
 * Create CODAP text.
 *
 * @param name - The name of the new text
 * @param content - The content of the new text
 * @returns A promise of the name of the newly created text
 */
export async function createText(
  name: string,
  content: string,
  {
    width = TEXT_WIDTH,
    height = TEXT_HEIGHT,
  }: { width: number; height: number }
): Promise<string> {
  const textName = await ensureUniqueName(
    name,
    CodapListResource.ComponentList
  );

  return new Promise<string>((resolve, reject) =>
    phone.call(
      {
        action: CodapActions.Create,
        resource: CodapResource.Component,
        values: {
          type: CodapComponentType.Text,
          name: name,
          dimensions: {
            width: width,
            height: height,
          },
          text: {
            object: "value",
            document: {
              children: [
                {
                  type: "paragraph",
                  children: [
                    {
                      text: content,
                    },
                  ],
                },
              ],
              objTypes: {
                paragraph: "block",
              },
            },
          },
        },
      },
      (response) => {
        if (response.success) {
          resolve(textName);
        } else {
          reject(new Error("Failed to create text"));
        }
      }
    )
  );
}

/**
 * Update CODAP Text.
 *
 * @param name - Name of the text object to update
 * @param content - New content of the text object
 */
export async function updateText(name: string, content: string): Promise<void> {
  return new Promise<void>((resolve, reject) =>
    phone.call(
      {
        action: CodapActions.Update,
        resource: resourceFromComponent(name),
        values: {
          type: CodapComponentType.Text,
          name: name,
          text: {
            object: "value",
            document: {
              children: [
                {
                  type: "paragraph",
                  children: [
                    {
                      text: content,
                    },
                  ],
                },
              ],
              objTypes: {
                paragraph: "block",
              },
            },
          },
        },
      },
      (response) => {
        if (response.success) {
          resolve();
        } else {
          reject(new Error("Failed to update text"));
        }
      }
    )
  );
}

/**
 * Using `name` as a base, return a name that is unique in CODAP.
 *
 * @param name - Base name
 * @param resourceType - The type of resource for which to check for name
 * duplicates
 * @returns A promise of a unique name with `name` as a base
 */
async function ensureUniqueName(
  name: string,
  resourceType: CodapListResource
): Promise<string> {
  // Find list of existing resources of the relevant type
  const resourceList: CodapIdentifyingInfo[] = await new Promise<
    CodapIdentifyingInfo[]
  >((resolve, reject) =>
    phone.call(
      {
        action: CodapActions.Get,
        resource: resourceType,
      },
      (response) => {
        if (response.success) {
          resolve(response.values);
        } else {
          reject(new Error(`Failed to fetch list of existing ${resourceType}`));
        }
      }
    )
  );

  return uniqueName(
    name,
    resourceList.map((x) => x.name)
  );
}

/**
 * Create a data context and table with the given dataset object.
 *
 * @param dataset - Dataset from which to create a context and table
 * @param name - Base name for the context and table
 * @returns A promise of a tuple, the first element of which is the identifying
 * information for the newly created context, and the second element of which
 * is the created table
 */
export async function createTableWithDataset(
  dataset: Dataset,
  name?: string
): Promise<[CodapIdentifyingInfo, CaseTable]> {
  let baseName;
  if (!name) {
    baseName = getNewName();
  } else {
    baseName = name;
  }

  // Generate names
  let contextName = `${baseName} Context`;
  let tableName = `${baseName}`;

  // Ensure names are unique
  contextName = await ensureUniqueName(
    contextName,
    CodapListResource.DataContextList
  );
  tableName = await ensureUniqueName(
    tableName,
    CodapListResource.ComponentList
  );

  // Create context and table;
  const newContext = await createContextWithDataset(dataset, contextName);

  const newTable = await createTable(tableName, contextName);
  return [newContext, newTable];
}
