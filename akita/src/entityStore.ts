import { isEmpty } from './isEmpty';
import { SetEntities, setEntities } from './setEntities';
import { Store } from './store';
import { Constructor, EntityState, EntityUICreateFn, ID, IDS, OrArray, StateWithActive, UpdateEntityPredicate, UpdateStateCallback } from './types';
import { getActiveEntities, SetActiveOptions } from './getActiveEntities';
import { addEntities, AddEntitiesOptions } from './addEntities';
import { coerceArray } from './coerceArray';
import { removeEntities } from './removeEntities';
import { getInitialEntitiesState } from './getInitialEntitiesState';
import { isDefined } from './isDefined';
import { updateEntities } from './updateEntities';
import { transaction } from './transaction';
import { isNil } from './isNil';
import { isFunction } from './isFunction';
import { isUndefined } from './isUndefined';
import { StoreConfigOptions } from './storeConfig';
import { logAction, setAction } from './actions';
import { isDev } from './env';
import { hasEntity } from './hasEntity';
import { Observable, Subject } from 'rxjs';
import { EntityAction, EntityActions } from './entityActions';
import { DEFAULT_ID_KEY } from './defaultIDKey';

/**
 *
 * Store for managing a collection of entities
 *
 * @example
 *
 * export interface WidgetsState extends EntityState<Widget> { }
 *
 * @StoreConfig({ name: 'widgets' })
 *  export class WidgetsStore extends EntityStore<WidgetsState> {
 *   constructor() {
 *     super();
 *   }
 * }
 *
 *
 */
export class EntityStore<S extends EntityState = any, DEPRECATED = any> extends Store<S> {
  ui: EntityUIStore<any, DEPRECATED>;
  private entityActions = new Subject<EntityAction>();

  constructor(initialState: Partial<S> = {}, protected options: Partial<StoreConfigOptions> = {}) {
    super({ ...getInitialEntitiesState(), ...initialState }, options);
  }

  // @internal
  get selectEntityAction$(): Observable<EntityAction> {
    return this.entityActions.asObservable();
  }

  // @internal
  get idKey() {
    return (this.config as StoreConfigOptions).idKey || this.options.idKey || DEFAULT_ID_KEY;
  }

  /**
   *
   * Replace current collection with provided collection
   *
   * @example
   *
   * this.store.set([Entity, Entity])
   * this.store.set({ids: [], entities: {}})
   * this.store.set({ 1: {}, 2: {}})
   *
   */
  set(entities: SetEntities<S['entities'][0]>) {
    if(isNil(entities)) return;

    isDev() && setAction('Set Entity');

    const isNativePreAdd = this.akitaPreAddEntity === EntityStore.prototype.akitaPreAddEntity;
    this._setState(state =>
      setEntities({
        state,
        entities,
        idKey: this.idKey,
        preAddEntity: this.akitaPreAddEntity,
        isNativePreAdd
      })
    );

    this.updateCache();

    if(this.hasInitialUIState()) {
      this.handleUICreation();
    }

    this.entityActions.next({ type: EntityActions.Set, ids: this.ids });
  }

  /**
   * Add entities
   *
   * @example
   *
   * this.store.add([Entity, Entity])
   * this.store.add(Entity)
   * this.store.add(Entity, { prepend: true })
   *
   * this.store.add(Entity, { loading: false })
   */
  add(entities: OrArray<S['entities'][0]>, options: AddEntitiesOptions = { loading: false }) {
    const collection = coerceArray(entities);

    if(isEmpty(collection)) return;

    const data = addEntities({
      state: this._value(),
      preAddEntity: this.akitaPreAddEntity,
      entities: collection,
      idKey: this.idKey,
      options
    });

    if(data) {
      isDev() && setAction('Add Entity');

      this._setState(() => ({
        ...data.newState,
        loading: options.loading
      }));
      if(this.hasInitialUIState()) {
        this.handleUICreation(true);
      }

      this.entityActions.next({ type: EntityActions.Add, ids: data.newIds });
    }
  }

  /**
   *
   * Update entities
   *
   * @example
   *
   * store.update(1, entity => ...)
   * store.update([1, 2, 3], entity => ...)
   * store.update(null, entity => ...)
   */
  update(id: OrArray<S['ids'][0]> | null, newStateFn: UpdateStateCallback<S['entities'][0]>);
  /**
   * store.update(1, { name: newName })
   */
  update(id: OrArray<S['ids'][0]> | null, newState: Partial<S['entities'][0]>);
  /**
   * store.update(entity => entity.price > 3, entity => ({ name: newName }))
   */
  update(predicate: UpdateEntityPredicate<S['entities'][0]>, newStateFn: UpdateStateCallback<S['entities'][0]>);
  /**
   * store.update(entity => entity.price > 3, { name: newName })
   */
  update(predicate: UpdateEntityPredicate<S['entities'][0]>, newState: Partial<S['entities'][0]>);
  /** Support non-entity updates */
  update(newState: UpdateStateCallback<S>);
  update(newState: Partial<S>);
  update(idsOrFnOrState: OrArray<S['ids'][0]> | null | Partial<S> | UpdateStateCallback<S> | UpdateEntityPredicate<S['entities'][0]>, newStateOrFn?: UpdateStateCallback<S['entities'][0]> | Partial<S['entities'][0]> | Partial<S>) {
    if(isUndefined(newStateOrFn)) {
      super.update(idsOrFnOrState as Partial<S>);
      return;
    }
    let ids: S['ids'][0][] = [];

    if(isFunction(idsOrFnOrState)) {
      // We need to filter according the predicate function
      ids = this.ids.filter(id => (idsOrFnOrState as UpdateEntityPredicate<S['entities'][0]>)(this.entities[id]));
    } else {
      // If it's nil we want all of them
      ids = isNil(idsOrFnOrState) ? this.ids : coerceArray(idsOrFnOrState);
    }

    if(isEmpty(ids)) return;

    isDev() && setAction('Update Entity', ids);
    this._setState(state =>
      updateEntities({
        idKey: this.idKey,
        ids,
        preUpdateEntity: this.akitaPreUpdateEntity,
        state,
        newStateOrFn
      })
    );

    this.entityActions.next({ type: EntityActions.Update, ids });
  }

  /**
   *
   * Create or update
   *
   * @example
   *
   * store.upsert(1, { active: true })
   * store.upsert([2, 3], { active: true })
   * store.upsert([2, 3], entity => ({ isOpen: !entity.isOpen}))
   *
   */
  @transaction()
  upsert(ids: OrArray<S['ids'][0]>, newState: Partial<S['entities'][0]> | S['entities'][0] | UpdateStateCallback<S['entities'][0]> | S['entities'][0][], options: { baseClass?: Constructor } = {}) {
    const toArray = coerceArray(ids);
    const predicate = isUpdate => id => hasEntity(this.entities, id) === isUpdate;
    const isClassBased = isFunction(options.baseClass);
    const updateIds = toArray.filter(predicate(true));
    const newEntities = toArray.filter(predicate(false)).map(id => {
      let entity = isFunction(newState) ? newState({} as S['entities'][0]) : newState;
      const withId = { ...(entity as S['entities'][0]), [this.idKey]: id };
      if(isClassBased) {
        return new options.baseClass(withId);
      }
      return withId;
    });

    // it can be any of the three types
    this.update(updateIds as any, newState as any);
    this.add(newEntities);
    isDev() && logAction('Upsert Entity');
  }

  /**
   *
   * Upsert entity collection (idKey must be present)
   *
   * @example
   *
   * store.upsertMany([ { id: 1 }, { id: 2 }]);
   *
   * store.upsertMany([ { id: 1 }, { id: 2 }], { loading: true  });
   * store.upsertMany([ { id: 1 }, { id: 2 }], { baseClass: Todo  });
   *
   */
  upsertMany(entities: S['entities'][0][], options: { baseClass?: Constructor; loading?: boolean } = {}) {
    const addedIds = [];
    const updatedIds = [];
    const updatedEntities = {};

    // Update the state directly to optimize performance
    for(const entity of entities) {
      const id = entity[this.idKey];
      if(hasEntity(this.entities, id)) {
        updatedEntities[id] = { ...this._value().entities[id], ...entity };
        updatedIds.push(id);
      } else {
        const newEntity = options.baseClass ? new options.baseClass(entity) : entity;
        addedIds.push(id);
        updatedEntities[id] = newEntity;
      }
    }

    isDev() && logAction('Upsert Many');

    this._setState(state => ({
      ...state,
      ids: addedIds.length ? [...state.ids, ...addedIds] : state.ids,
      entities: {
        ...state.entities,
        ...updatedEntities
      },
      loading: !!options.loading
    }));

    updatedIds.length && this.entityActions.next({ type: EntityActions.Update, ids: updatedIds });
    addedIds.length && this.entityActions.next({ type: EntityActions.Add, ids: addedIds });
  }

  /**
   *
   * Replace one or more entities (except the id property)
   *
   *
   * @example
   *
   * this.store.replace(5, newEntity)
   * this.store.replace([1,2,3], newEntity)
   */
  replace(ids: IDS, newState: Partial<S['entities'][0]>) {
    const toArray = coerceArray(ids);
    if(isEmpty(toArray)) return;
    let replaced = {};
    for(const id of toArray) {
      newState[this.idKey] = id;
      replaced[id] = newState;
    }
    isDev() && setAction('Replace Entity', ids);
    this._setState((state) => ({
      ...state,
      entities: {
        ...state.entities,
        ...replaced
      }
    }));
  }

  /**
   *
   * Remove one or more entities
   *
   * @example
   *
   * this.store.remove(5)
   * this.store.remove([1,2,3])
   * this.store.remove()
   */
  remove(id?: OrArray<S['ids'][0]>);
  /**
   * this.store.remove(entity => entity.id === 1)
   */
  remove(predicate: (entity: Readonly<S['entities'][0]>) => boolean);
  remove(idsOrFn?: OrArray<S['ids'][0]> | ((entity: Readonly<S['entities'][0]>) => boolean)) {
    if(isEmpty(this.ids)) return;

    const idPassed = isDefined(idsOrFn);

    // null means remove all
    let ids: ID[] | null = [];

    if(isFunction(idsOrFn)) {
      ids = this.ids.filter(entityId => idsOrFn(this.entities[entityId]));
    } else {
      ids = idPassed ? coerceArray(idsOrFn) : null;
    }

    if(isEmpty(ids)) return;

    isDev() && setAction('Remove Entity', ids);
    this._setState((state: StateWithActive<S>) => removeEntities({ state, ids }));
    if(ids === null) {
      this.setHasCache(false);
    }

    this.handleUIRemove(ids);
    this.entityActions.next({ type: EntityActions.Remove, ids });
  }

  /**
   *
   * Update the active entity
   *
   * @example
   *
   * this.store.updateActive({ completed: true })
   * this.store.updateActive(active => {
   *   return {
   *     config: {
   *      ..active.config,
   *      date
   *     }
   *   }
   * })
   */
  updateActive(newStateOrCallback: UpdateStateCallback<S['entities'][0]> | Partial<S['entities'][0]>) {
    const ids = coerceArray(this.active);
    isDev() && setAction('Update Active', ids);
    this.update(ids, newStateOrCallback as Partial<S['entities'][0]>);
  }

  /**
   * Set the given entity as active
   *
   * @example
   *
   * store.setActive(1)
   * store.setActive([1, 2, 3])
   */
  setActive(idOrOptions: S['active'] extends any[] ? S['active'] : (SetActiveOptions | S['active']));
  setActive(idOrOptions: S['ids'][0] | SetActiveOptions | null) {
    const active = getActiveEntities(idOrOptions, this.ids, this.active);

    if(active === undefined) {
      return;
    }

    isDev() && setAction('Set Active', active);
    this._setActive(active);
  }

  /**
   * Add active entities
   *
   * @example
   *
   * store.addActive(2);
   * store.addActive([3, 4, 5]);
   */
  addActive<T = OrArray<S['ids'][0]>>(ids: T) {
    const toArray = coerceArray(ids);
    if(isEmpty(toArray)) return;
    const everyExist = toArray.every(id => this.active.indexOf(id) > -1);
    if(everyExist) return;

    isDev() && setAction('Add Active', ids);
    this._setState(state => {
      /** Protect against case that one of the items in the array exist */
      const uniques = Array.from(new Set([...(state.active as S['ids'][0][]), ...toArray]));
      return {
        ...state,
        active: uniques
      };
    });
  }

  /**
   * Remove active entities
   *
   * @example
   *
   * store.removeActive(2)
   * store.removeActive([3, 4, 5])
   */
  removeActive<T = OrArray<S['ids'][0]>>(ids: T) {
    const toArray = coerceArray(ids);
    if(isEmpty(toArray)) return;
    const someExist = toArray.some(id => this.active.indexOf(id) > -1);
    if(!someExist) return;

    isDev() && setAction('Remove Active', ids);
    this._setState(state => {
      return {
        ...state,
        active: state.active.filter(currentId => toArray.indexOf(currentId) === -1)
      };
    });
  }

  /**
   * Toggle active entities
   *
   * @example
   *
   * store.toggle(2)
   * store.toggle([3, 4, 5])
   */
  @transaction()
  toggleActive<T = OrArray<S['ids'][0]>>(ids: T) {
    const toArray = coerceArray(ids);
    const filterExists = remove => id => this.active.includes(id) === remove;
    const remove = toArray.filter(filterExists(true));
    const add = toArray.filter(filterExists(false));
    this.removeActive(remove);
    this.addActive(add);
    isDev() && logAction('Toggle Active');
  }

  /**
   *
   * Create sub UI store for managing Entity's UI state
   *
   * @example
   *
   * export type ProductUI = {
   *   isLoading: boolean;
   *   isOpen: boolean
   * }
   *
   * interface ProductsUIState extends EntityState<ProductUI> {}
   *
   * export class ProductsStore EntityStore<ProductsState, Product> {
   *   ui: EntityUIStore<ProductsUIState, ProductUI>;
   *
   *   constructor() {
   *     super();
   *     this.createUIStore();
   *   }
   *
   * }
   */
  createUIStore(initialState = {}, storeConfig: Partial<StoreConfigOptions> = {}) {
    const defaults: Partial<StoreConfigOptions> = { name: `UI/${this.storeName}`, idKey: this.idKey };
    this.ui = new EntityUIStore(initialState, { ...defaults, ...storeConfig });
    return this.ui;
  }

  // @internal
  destroy() {
    super.destroy();
    if(this.ui instanceof EntityStore) {
      this.ui.destroy();
    }
    this.entityActions.complete();
  }

  // @internal
  akitaPreUpdateEntity(_: Readonly<S['entities'][0]>, nextEntity: Readonly<S['entities'][0]>): S['entities'][0] {
    return nextEntity;
  }

  // @internal
  akitaPreAddEntity(newEntity: Readonly<S['entities'][0]>): S['entities'][0] {
    return newEntity;
  }

  private get ids() {
    return this._value().ids;
  }

  private get entities() {
    return this._value().entities;
  }

  private get active() {
    return this._value().active;
  }

  private _setActive(ids: OrArray<S['ids'][0]>) {
    this._setState(state => {
      return {
        ...state,
        active: ids
      };
    });
  }

  private updateCache() {
    this.setHasCache(true);
    const ttlConfig = this.cacheConfig && this.cacheConfig.ttl;
    if(ttlConfig) {
      if(this.cache.ttl !== null) {
        clearTimeout(this.cache.ttl);
      }
      this.cache.ttl = <any>setTimeout(() => this.setHasCache(false), ttlConfig);
    }
  }

  private handleUICreation(add = false) {
    const ids = this.ids;
    const isFunc = isFunction(this.ui._akitaCreateEntityFn);
    let uiEntities;
    const createFn = id => {
      const current = this.entities[id];
      const ui = isFunc ? this.ui._akitaCreateEntityFn(current) : this.ui._akitaCreateEntityFn;
      return {
        [this.idKey]: current[this.idKey],
        ...ui
      };
    };

    if(add) {
      uiEntities = this.ids.filter(id => isUndefined(this.ui.entities[id])).map(createFn);
    } else {
      uiEntities = ids.map(createFn);
    }

    add ? this.ui.add(uiEntities) : this.ui.set(uiEntities);
  }

  private hasInitialUIState() {
    return this.hasUIStore() && isUndefined(this.ui._akitaCreateEntityFn) === false;
  }

  private handleUIRemove(ids: S['ids'][0][]) {
    if(this.hasUIStore()) {
      this.ui.remove(ids);
    }
  }

  private hasUIStore() {
    return this.ui instanceof EntityUIStore;
  }
}

// @internal
export class EntityUIStore<UIState, DEPRECATED = any> extends EntityStore<UIState> {
  _akitaCreateEntityFn: EntityUICreateFn;

  constructor(initialState = {}, storeConfig: Partial<StoreConfigOptions> = {}) {
    super(initialState, storeConfig);
  }

  /**
   *
   * Set the initial UI entity state. This function will determine the entity's
   * initial state when we call `set()` or `add()`.
   *
   * @example
   *
   * constructor() {
   *   super();
   *   this.createUIStore().setInitialEntityState(entity => ({ isLoading: false, isOpen: true }));
   *   this.createUIStore().setInitialEntityState({ isLoading: false, isOpen: true });
   * }
   *
   */
  setInitialEntityState<EntityUI = any, Entity = any>(createFn: EntityUICreateFn<EntityUI, Entity>) {
    this._akitaCreateEntityFn = createFn;
  }
}
