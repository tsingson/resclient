
import { eventBus } from 'modapp';
import { obj } from 'modapp-utils';
import CacheItem from './CacheItem';
import TypeList from './TypeList';
import ResCollection from './ResCollection';
import ResModel from './ResModel';
import ResError from './ResError';

const defaultModelFactory = function(api, rid) {
	return new ResModel(api, rid);
};
const defaultCollectionFactory = function(api, rid) {
	return new ResCollection(api, rid);
};
const errorFactory = function(api, rid) {
	return new ResError(rid);
};

// Resource types
const typeCollection = 'collection';
const typeModel = 'model';
const typeError = 'error';
const resourceTypes = [ typeModel, typeCollection, typeError ];
// Actions
const actionDelete = { action: 'delete' };
// Default settings
const defaultNamespace = 'resclient';
const reconnectDelay = 3000;
const subscribeStaleDelay = 2000;
// Traverse states
const stateNone = 0;
const stateDelete = 1;
const stateKeep = 2;
const stateStale = 3;

/**
 * ResClient is a client implementing the RES-Client protocol.
 */
class ResClient {

	/**
	 * Creates a ResClient instance
	 * @param {string} hostUrl Websocket host path. May be relative to current path.
	 * @param {object} [opt] Optional parameters.
	 * @param {function} [opt.onConnect] On connect callback called prior resolving the connect promise and subscribing to stale resources. May return a promise.
	 * @param {string} [opt.namespace] Event bus namespace. Defaults to 'resclient'.
	 * @param {module:modapp~EventBus} [opt.eventBus] Event bus.
	 */
	constructor(hostUrl, opt) {
		this.hostUrl = this._resolvePath(hostUrl);
		obj.update(this, opt, {
			onConnect: { type: '?function' },
			namespace: { type: 'string', default: defaultNamespace },
			eventBus: { type: 'object', default: eventBus }
		});

		this.tryConnect = false;
		this.connected = false;
		this.ws = null;
		this.requests = {};
		this.reqId = 1; // Incremental request id
		this.cache = {};
		this.stale = null;

		// Queue promises
		this.connectPromise = null;
		this.connectCallback = null;

		// Types
		this.types = {
			model: {
				id: typeModel,
				list: new TypeList(defaultModelFactory),
				prepareData: dta => {
					let o = Object.assign({}, dta);
					let v;
					for (let k in o) {
						v = o[k];
						// Is the value a reference, get the actual item from cache
						if (typeof v === 'object' && v !== null && v.rid) {
							let ci = this.cache[v.rid];
							ci.addIndirect();
							o[k] = ci.item;
						}
					}
					return o;
				},
				getFactory: function(rid) { return this.list.getFactory(rid); },
				synchronize: this._syncModel.bind(this)
			},
			collection: {
				id: typeCollection,
				list: new TypeList(defaultCollectionFactory),
				prepareData: dta => dta.map(v => {
					// Is the value a reference, get the actual item from cache
					if (typeof v === 'object' && v !== null && v.rid) {
						let ci = this.cache[v.rid];
						ci.addIndirect();
						return ci.item;
					}
					return v;
				}),
				getFactory: function(rid) { return this.list.getFactory(rid); },
				synchronize: this._syncCollection.bind(this)
			},
			error: {
				id: typeError,
				prepareData: dta => dta,
				getFactory: rid => errorFactory,
				synchronize: () => {}
			}
		};

		// Bind callbacks
		this._handleOnopen = this._handleOnopen.bind(this);
		this._handleOnerror = this._handleOnerror.bind(this);
		this._handleOnmessage = this._handleOnmessage.bind(this);
		this._handleOnclose = this._handleOnclose.bind(this);
		this._unsubscribe = this._unsubscribe.bind(this);
	}

	/**
	 * Connects the instance to the server.
	 * Can be called even if a connection is already established.
	 * @returns {Promise} A promise to the established connection.
	 */
	connect() {
		this.tryConnect = true;

		return this.connectPromise = this.connectPromise || new Promise((resolve, reject) => {
			this.connectCallback = { resolve, reject };
			this.ws = new WebSocket(this.hostUrl);

			this.ws.onopen = this._handleOnopen;
			this.ws.onerror = this._handleOnerror;
			this.ws.onmessage = this._handleOnmessage;
			this.ws.onclose = this._handleOnclose;
		});
	}

	/**
	 * Disconnects any current connection and stops attempts
	 * of reconnecting.
	 */
	disconnect() {
		this.tryConnect = false;

		if (this.ws) {
			this.ws.close();
			this._connectReject({ code: 'system.disconnect', message: "Disconnect called" });
		}
	}

	/**
	 * Gets the host URL to the RES API
	 * @returns {string} Host URL
	 */
	getHostUrl() {
		return this.hostUrl;
	}

	/**
	 * Attach an  event handler function for one or more instance events.
	 * @param {?string} events One or more space-separated events. Null means any event.
	 * @param {eventCallback} handler A function to execute when the event is emitted.
	 */
	on(events, handler) {
		this.eventBus.on(this, events, handler, this.namespace);
	}

	 /**
	 * Remove an instance event handler.
	 * @param {?string} events One or more space-separated events. Null means any event.
	 * @param {eventCallback} [handler] An optional handler function. The handler will only be remove if it is the same handler.
	 */
	off(events, handler) {
		this.eventBus.off(this, events, handler, this.namespace);
	}

	/**
	 * Sets the onConnect callback.
	 * @param {?function} onConnect On connect callback called prior resolving the connect promise and subscribing to stale resources. May return a promise.
	 * @returns {this}
	 */
	setOnConnect(onConnect) {
		this.onConnect = onConnect;
		return this;
	}

	/**
	 * Resource factory callback
	 * @callback resourceFactoryCallback
	 * @param {ResClient} api ResClient instance
	 * @param {string} rid Resource ID
	 */

	/**
	 * Register a model type.
	 * The pattern may use the following wild cards:
	 * * The asterisk (*) matches any part at any level of the resource name.
	 * * The greater than symbol (>) matches one or more parts at the end of a resource name, and must be the last part.
	 * @param {string} pattern Pattern of the model type.
	 * @param {resourceFactoryCallback} factory Model factory callback
	 */
	registerModelType(pattern, factory) {
		this.types.model.list.addFactory(pattern, factory);
	}

	/**
	 * Unregister a previously registered model type pattern.
	 * @param {string} pattern Pattern of the model type.
	 * @returns {resourceFactoryCallback} Unregistered model factory callback
	 */
	unregisterModelType(pattern) {
		return this.types.model.list.removeFactory(pattern);
	}

	/**
	 * Register a collection type.
	 * The pattern may use the following wild cards:
	 * * The asterisk (*) matches any part at any level of the resource name.
	 * * The greater than symbol (>) matches one or more parts at the end of a resource name, and must be the last part.
	 * @param {string} pattern Pattern of the collection type.
	 * @param {ResClient~resourceFactoryCallback} factory Collection factory callback
	 */
	registerCollectionType(pattern, factory) {
		this.types.collection.list.addFactory(pattern, factory);
	}

	/**
	 * Unregister a previously registered collection type pattern.
	 * @param {string} pattern Pattern of the collection type.
	 * @returns {resourceFactoryCallback} Unregistered collection factory callback
	 */
	unregisterCollectionType(pattern) {
		return this.types.model.list.removeFactory(pattern);
	}

	/**
	 * Get a resource from the API
	 * @param {string} rid Resource ID
	 * @param {function} [collectionFactory] Collection factory function.
	 * @return {Promise.<(ResModel|ResCollection)>} Promise of the resource.
	 */
	get(rid) {
		// Check for resource in cache
		let ci = this.cache[rid];
		if (ci) {
			return ci.promise ? ci.promise : Promise.resolve(ci.item);
		}

		ci = new CacheItem(rid, this._unsubscribe);
		this.cache[rid] = ci;

		return ci.setPromise(
			this._subscribe(ci, true).then(() => ci.item)
		);
	}

	/**
	 * Calls a method on a resource.
	 * @param {string} rid Resource ID.
	 * @param {string} method Method name
	 * @param {*} params Method parameters
	 * @returns {Promise.<object>} Promise of the call result.
	 */
	call(rid, method, params) {
		return this._send('call', rid, method || '', params);
	}

	/**
	 * Invokes a authentication method on a resource.
	 * @param {string} rid Resource ID.
	 * @param {string} method Method name
	 * @param {*} params Method parameters
	 * @returns {Promise.<object>} Promise of the authentication result.
	 */
	authenticate(rid, method, params) {
		return this._send('auth', rid, method || '', params);
	}

	/**
	 * Creates a new resource by calling the 'new' method.
	 * @param {*} rid Resource ID
	 * @param {*} params Method parameters
	 * @return {Promise.<(ResModel|ResCollection)>} Promise of the resource.
	 */
	create(rid, params) {
		return this._send('new', rid, null, params)
			.then(response => {
				this._cacheResources(response);
				let ci = this.cache[response.rid];
				ci.setSubscribed(true);
				return ci.item;
			});
	}

	/**
	 * Calls the set method to update model properties.
	 * @param {string} modelId Model resource ID.
	 * @param {object} props Properties. Set value to undefined to delete a property.
	 * @returns {Promise.<object>} Promise of the call being completed.
	 */
	setModel(modelId, props) {
		props = Object.assign({}, props);
		// Replace undefined with actionDelete object
		Object.keys(props).forEach(k => {
			if (props[k] === undefined) {
				props[k] = actionDelete;
			}
		});

		return this._send('call', modelId, 'set', props);
	}

	resourceOn(rid, events, handler) {
		let cacheItem = this.cache[rid];
		if (!cacheItem) {
			throw new Error("Resource not found in cache");
		}

		cacheItem.addDirect();
		this.eventBus.on(cacheItem.item, events, handler, this.namespace + '.resource.' + rid);
	}

	resourceOff(rid, events, handler) {
		let cacheItem = this.cache[rid];
		if (!cacheItem) {
			throw new Error("Resource not found in cache");
		}

		cacheItem.removeDirect();
		this.eventBus.off(cacheItem.item, events, handler, this.namespace + '.resource.' + rid);
	}

	/**
	 * Sends a JsonRpc call to the API
	 * @param {string} action Action name
	 * @param {string} rid Resource ID
	 * @param {?string} method Optional method name
	 * @param {?object} params Optional parameters
	 * @returns {Promise.<object>} Promise to the response
	 * @private
	 */
	_send(action, rid, method, params) {
		if (!rid) {
			throw new Error("Invalid resource ID");
		}

		if (method === "") {
			throw new Error("Invalid method");
		}

		let m = action + '.' + rid + (method ? '.' + method : '');

		return this.connected
			? this._sendNow(m, params)
			: this.connect()
				.catch(e => { throw new ResError(rid, m, params).__init(e); })
				.then(() => this._sendNow(m, params));
	}

	_sendNow(method, params) {
		return new Promise((resolve, reject) => {
			// Prepare request object
			var req = { id: this.reqId++, method: method, params: params || undefined };

			this.requests[req.id] = {
				method: method,
				params: req.params,
				resolve: resolve,
				reject: reject
			};

			var json = JSON.stringify(req);
			this.ws.send(json);
		});
	}

	/**
	 * Receives a incoming json encoded data string and executes the appropriate functions/callbacks.
	 * @param {string} json Json encoded data
	 * @private
	 */
	_receive(json) {
		let data = JSON.parse(json.trim());

		if (data.hasOwnProperty('id')) {

			// Find the stored request
			let req = this.requests[data.id];
			if (!req) {
				throw new Error("Server response without matching request");
			}

			delete this.requests[data.id];

			if (data.hasOwnProperty("error")) {
				this._handleErrorResponse(req, data);
			} else {
				this._handleSuccessResponse(req, data);
			}
		} else if (data.hasOwnProperty('event')) {
			this._handleEvent(data);
		} else {
			throw new Error("Invalid message from server: " + json);
		}
	}

	_handleErrorResponse(req, data) {
		let m = req.method;
		// Extract the rid if possible
		let rid = "";
		let i = m.indexOf('.');
		if (i >= 0) {
			rid = m.substr(i + 1);
			let a = m.substr(0, i);
			if (a === 'call' || a === 'auth') {
				i = rid.lastIndexOf('.');
				if (i >= 0) {
					rid = rid.substr(0, i);
				}
			}
		}
		let err = new ResError(
			rid.trim(),
			m,
			req.params
		);
		err.__init(data.error);
		try {
			this._emit('error', err);
		} catch (ex) {}

		// Execute error callback bound to calling object
		req.reject(err);
	}

	_handleSuccessResponse(req, data) {
		// Execute success callback bound to calling object
		req.resolve(data.result);
	}

	_handleEvent(data) {
		// Event
		let idx = data.event.lastIndexOf('.');
		if (idx < 0 || idx === data.event.length - 1) {
			throw new Error("Malformed event name: " + data.event);
		}

		let rid = data.event.substr(0, idx);

		let cacheItem = this.cache[rid];
		if (!cacheItem) {
			throw new Error("Resource not found in cache");
		}

		let event = data.event.substr(idx + 1);
		let handled = false;
		switch (event) {
		case 'change':
			handled = this._handleChangeEvent(cacheItem, event, data.data);
			break;

		case 'add':
			handled = this._handleAddEvent(cacheItem, event, data.data);
			break;

		case 'remove':
			handled = this._handleRemoveEvent(cacheItem, event, data.data);
			break;

		case 'unsubscribe':
			handled = this._handleUnsubscribeEvent(cacheItem, event);
			break;
		}

		if (!handled) {
			this.eventBus.emit(cacheItem.item, this.namespace + '.resource.' + rid + '.' + event, data.data);
		}
	}

	_handleChangeEvent(cacheItem, event, data) {
		if (cacheItem.type !== typeModel) {
			return false;
		}

		this._cacheResources(data);

		// Set deleted properties to undefined
		let item = cacheItem.item;
		let rm = {};
		let v, ov, ci, r;
		let vals = data.values;
		for (let k in vals) {
			v = vals[k];
			if (typeof v === 'object' && v !== null) {
				if (v.action === 'delete') {
					vals[k] = undefined;
				} else if (v.rid) {
					ci = this.cache[v.rid];
					vals[k] = ci.item;
					if (rm.hasOwnProperty(v.rid)) {
						rm[v.rid]--;
					} else {
						rm[v.rid] = -1;
					}
				} else {
					throw new Error("Unsupported model change value: ", v);
				}
			}

			ov = item[k];
			if (this._isResource(ov)) {
				let rid = ov.getResourceId();
				if (rm.hasOwnProperty(rid)) {
					rm[rid]++;
				} else {
					rm[rid] = 1;
				}
			}
		}

		// Remove indirect reference to resources no longer referenced in the model
		for (let rid in rm) {
			r = rm[rid];
			ci = this.cache[rid];
			ci.removeIndirect(r);
			if (r > 0) {
				this._tryDelete(ci);
			}
		}

		// Update the model with new values
		let changed = cacheItem.item.__update(vals);
		if (changed) {
			this.eventBus.emit(cacheItem.item, this.namespace + '.resource.' + cacheItem.rid + '.' + event, changed);
		}

		return true;
	}

	_handleAddEvent(cacheItem, event, data) {
		if (cacheItem.type !== typeCollection) {
			return false;
		}

		let v = data.value;
		let idx = data.idx;

		// Get resource if value is a resource reference
		if (v !== null && typeof v === 'object' && v.rid) {
			this._cacheResources(data);
			let ci = this.cache[v.rid];
			ci.addIndirect();
			v = ci.item;
		}
		cacheItem.item.__add(v, idx);
		this.eventBus.emit(cacheItem.item, this.namespace + '.resource.' + cacheItem.rid + '.' + event, { item: v, idx });
		return true;
	}

	_handleRemoveEvent(cacheItem, event, data) {
		if (cacheItem.type !== typeCollection) {
			return false;
		}

		let idx = data.idx;
		let item = cacheItem.item.__remove(idx);
		this.eventBus.emit(cacheItem.item, this.namespace + '.resource.' + cacheItem.rid + '.' + event, { item, idx });

		if (this._isResource(item)) {
			let refItem = this.cache[item.getResourceId()];
			if (!refItem) {
				throw new Error("Removed model is not in cache");
			}

			refItem.removeIndirect();
			this._tryDelete(refItem);
		}
		return true;
	}

	_handleUnsubscribeEvent(cacheItem, event) {
		cacheItem.setSubscribed(false);
		this._tryDelete(cacheItem);
		this.eventBus.emit(cacheItem.item, this.namespace + '.resource.' + cacheItem.rid + '.' + event, { item: cacheItem.item });
		return true;
	}

	_setStale(rid) {
		this._addStale(rid);
		if (this.connected) {
			setTimeout(() => this._subscribeToStale(rid), subscribeStaleDelay);
		}
	}

	_addStale(rid) {
		if (!this.stale) {
			this.stale = {};
		}
		this.stale[rid] = true;
	}

	_removeStale(rid) {
		if (this.stale) {
			delete this.stale[rid];
			for (let k in this.stale) {
				return;
			}
			this.stale = null;
		}
	}

	_subscribe(ci, throwError) {
		let rid = ci.rid;
		ci.setSubscribed(true);
		this._removeStale(rid);
		return this._send('subscribe', rid)
			.then(response => this._cacheResources(response))
			.catch(err => {
				this._handleFailedSubscribe(ci);
				if (throwError) {
					throw err;
				}
			});
	}

	_subscribeToStale(rid) {
		if (!this.connected || !this.stale || !this.stale[rid]) {
			return;
		}

		this._subscribe(this.cache[rid]);
	}

	_subscribeToAllStale() {
		if (!this.stale) {
			return;
		}

		for (let rid in this.stale) {
			this._subscribeToStale(rid);
		}
	}

	/**
	 * Handles the websocket onopen event
	 * @param {object} e Open event object
	 * @private
	 */
	_handleOnopen(e) {
		this.connected = true;

		Promise.resolve(this.onConnect ? this.onConnect() : null)
			.then(() => {
				this._subscribeToAllStale();
				this._emit('connect', e);
				this._connectResolve();
			})
			.catch(err => {
				if (this.ws) {
					this.ws.close();
				}
			});
	}

	/**
	 * Handles the websocket onerror event
	 * @param {object} e Error event object
	 * @private
	 */
	_handleOnerror(e) {
		this._connectReject({ code: 'system.connectionError', message: "Connection error", data: e });
	}

	/**
	 * Handles the websocket onmessage event
	 * @param {object} e Message event object
	 * @private
	 */
	_handleOnmessage(e) {
		this._receive(e.data);
	}

	/**
	 * Handles the websocket onclose event
	 * @param {object} e Close event object
	 * @private
	 */
	_handleOnclose(e) {
		this.connectPromise = null;
		this.ws = null;
		if (this.connected) {
			this.connected = false;

			// Set any subscribed item in cache to stale
			for (let rid in this.cache) {
				let ci = this.cache[rid];
				if (ci.subscribed) {
					ci.setSubscribed(false);
					this._addStale(rid);
					this._tryDelete(ci);
				}
			}

			this._emit('close', e);
		}

		let hasStale = false;
		for (let _ in this.cache) { // eslint-disable-line no-unused-vars
			hasStale = true;
			break;
		}

		this.tryConnect = hasStale && this.tryConnect;

		if (this.tryConnect) {
			this._reconnect();
		}
	}

	/**
	 * Resolves the connection promise
	 * @private
	 */
	_connectResolve() {
		if (this.connectCallback) {
			this.connectCallback.resolve();
			this.connectCallback = null;
		}
	}

	/**
	 * Rejects the connection promise
	 * @param {*} e Error event
	 * @private
	 */
	_connectReject(e) {
		this.connectPromise = null;
		this.ws = null;

		if (this.connectCallback) {
			this.connectCallback.reject(e);
			this.connectCallback = null;
		}
	}

	_emit(event, data, ctx) {
		this.eventBus.emit(event, data, this.namespace);
	}

	/**
	 * Tries to delete the cached item.
	 * It will delete if there are no direct listeners, indirect references, or any subscription.
	 * @param {object} ci Cache item to delete
	 * @private
	 */
	_tryDelete(ci) {
		let refs = this._getRefState(ci);

		for (let rid in refs) {
			let r = refs[rid];
			switch (r.st) {
			case stateStale:
				this._setStale(rid);
				break;
			case stateDelete:
				this._deleteRef(r.ci);
				break;
			}
		}
	}

	/**
	 * Reference State object
	 * @typedef {object} RefState
	 * @property {CacheItem} ci Cache item
	 * @property {Number} rc Reference count from external references.
	 * @property {Number} st State. Is either stateDelete, stateKeep, or stateStale.
	 * @private
	 */

	/**
	 * Gets the reference state for a cacheItem and all its references
	 * if the cacheItem was to be removed.
	 * @param {CacheItem} ci Cache item
	 * @return {Object.<string, RefState>} A key value object with key being the rid, and value being a RefState array.
	 * @private
	 */
	_getRefState(ci) {
		let refs = {};
		// Quick exit
		if (ci.subscribed) {
			return refs;
		}
		refs[ci.rid] = { ci, rc: ci.indirect, st: stateNone };
		this._traverse(ci, this._seekRefs.bind(this, refs), 0, true);
		this._traverse(ci, this._markDelete.bind(this, refs), stateDelete);
		return refs;
	}

	/**
	 * Seeks for resources that no longer has any reference and may
	 * be deleted.
	 * Callback used with _traverse.
	 * @param {*} refs References
	 * @param {*} ci Cache item
	 * @param {*} state State as returned from parent's traverse callback
	 * @returns {*} State to pass to children. False means no traversing to children.
	 * @private
	 */
	_seekRefs(refs, ci, state) {
		// Quick exit if it is already subscribed
		if (ci.subscribed) {
			return false;
		}

		let rid = ci.rid;
		let r = refs[rid];
		if (!r) {
			refs[rid] = { ci, rc: ci.indirect - 1, st: stateNone };
			return true;
		}

		r.rc--;
		return false;
	}

	/**
	 * Marks reference as stateDelete, stateKeep, or stateStale, depending on
	 * the values returned from a _seekRefs traverse.
	 * @param {*} refs References
	 * @param {*} ci Cache item
	 * @param {*} state State as returned from parent's traverse callback
	 * @return {*} State to pass to children. False means no traversing to children.
	 * @private
	 */
	_markDelete(refs, ci, state) {
		// Quick exit if it is already subscribed
		if (ci.subscribed) {
			return false;
		}

		let rid = ci.rid;
		let r = refs[rid];

		if (r.st === stateKeep) {
			return false;
		}

		if (state === stateDelete) {

			if (r.rc > 0) {
				r.st = stateKeep;
				return rid;
			}

			if (r.st !== stateNone) {
				return false;
			}

			if (r.ci.direct) {
				r.st = stateStale;
				return rid;
			}

			r.st = stateDelete;
			return stateDelete;
		}

		// A stale item can never cover itself
		if (rid === state) {
			return false;
		}

		r.st = stateKeep;
		return r.rc > 0 ? rid : state;
	}

	_deleteRef(ci) {
		let item = ci.item, ri;
		switch (ci.type) {
		case typeCollection:
			for (let v of item) {
				ri = this._getRefItem(v);
				if (ri) {
					ri.removeIndirect();
				}
			}
			break;
		case typeModel:
			for (let k in item) {
				if (item.hasOwnProperty(k)) {
					ri = this._getRefItem(item[k]);
					if (ri) {
						ri.removeIndirect();
					}
				}
			}
			break;
		}
		delete this.cache[ci.rid];
		this._removeStale(ci.rid);
	}

	_isResource(v) {
		return v !== null && typeof v === 'object' && typeof v.getResourceId === 'function';
	}

	_getRefItem(v) {
		if (!this._isResource(v)) {
			return null;
		}
		let rid = v.getResourceId();
		let refItem = this.cache[rid];
		// refItem not in cache means
		// item has been deleted as part of
		// a refState object.
		if (!refItem) {
			return null;
		}
		return refItem;
	}

	_cacheResources(resources) {
		if (!resources) {
			return;
		}

		let sync = {};
		resourceTypes.forEach(t => (sync[t] = this._createItems(resources[t + 's'], this.types[t])));
		resourceTypes.forEach(t => this._initItems(resources[t + 's'], this.types[t]));
		resourceTypes.forEach(t => this._syncItems(sync[t], this.types[t]));
	}

	_createItems(refs, type) {
		if (!refs) {
			return;
		}

		let sync;
		for (let rid in refs) {
			let ci = this.cache[rid];
			if (!ci) {
				ci = this.cache[rid] = new CacheItem(
					rid,
					this._unsubscribe
				);
			} else {
				// Remove item as stale if needed
				this._removeStale(rid);
			}
			// If an item is already set,
			// it has gone stale and needs to be synchronized.
			if (ci.item) {
				if (ci.type !== type.id) {
					console.error("Resource type inconsistency");
				} else {
					sync = sync || {};
					sync[rid] = refs[rid];
				}
				delete refs[rid];
			} else {
				let f = type.getFactory(rid);
				ci.setItem(f(this, rid), type.id);
			}
		}

		return sync;
	}

	_initItems(refs, type) {
		if (!refs) {
			return;
		}

		for (let rid in refs) {
			let cacheItem = this.cache[rid];
			cacheItem.item.__init(type.prepareData(refs[rid]));
		}
	}

	_syncItems(refs, type) {
		if (!refs) {
			return;
		}

		for (let rid in refs) {
			let ci = this.cache[rid];
			type.synchronize(ci, refs[rid]);
		}
	}

	_syncModel(cacheItem, data) {
		this._handleChangeEvent(cacheItem, 'change', { values: data });
	}

	_syncCollection(cacheItem, data) {
		let collection = cacheItem.item;
		let i = collection.length;
		let a = new Array(i);
		while (i--) {
			a[i] = collection.atIndex(i);
		}

		let b = data.map(v => (
			v != null && typeof v === 'object' && v.rid
				// Is the value a reference, get the actual item from cache
				? this.cache[v.rid].item
				: v
		));;
		this._patchDiff(a, b,
			(id, m, n, idx) => {},
			(id, n, idx) => this._handleAddEvent(cacheItem, 'add', {
				value: data[n],
				idx: idx
			}),
			(id, m, idx) => this._handleRemoveEvent(cacheItem, 'remove', { idx })
		);
	}

	_patchDiff(a, b, onKeep, onAdd, onRemove) {
		// Do a LCS matric calculation
		// https://en.wikipedia.org/wiki/Longest_common_subsequence_problem
		let t, i, j, s = 0, aa, bb, m = a.length, n = b.length;

		// Trim of matches at the start and end
		while (s < m && s < n && a[s] === b[s]) {
			s++;
		}
		if (s === m && s === n) {
			return;
		}
		while (s < m && s < n && a[m - 1] === b[n - 1]) {
			m--;
			n--;
		}

		if (s > 0 || m < a.length) {
			aa = a.slice(s, m);
			m = aa.length;
		} else {
			aa = a;
		}
		if (s > 0 || n < b.length) {
			bb = b.slice(s, n);
			n = bb.length;
		} else {
			bb = b;
		}

		// Create matrix and initialize it
		let c = new Array(m + 1);
		for (i = 0; i <= m; i++) {
			c[i] = t = new Array(n + 1);
			t[0] = 0;
		}
		t = c[0];
		for (j = 1; j <= n; j++) {
			t[j] = 0;
		}

		for (i = 0; i < m; i++) {
			for (j = 0; j < n; j++) {
				c[i + 1][j + 1] = aa[i] === bb[j]
					? c[i][j] + 1
					: Math.max(c[i + 1][j], c[i][j + 1]);
			}
		}

		for (i = a.length - 1; i >= s + m; i--) {
			onKeep(a[i], i, i - m + n, i);
		}
		let idx = m + s;
		i = m;
		j = n;
		let r = 0;
		let adds = [];
		while (true) {
			m = i - 1;
			n = j - 1;
			if (i > 0 && j > 0 && aa[m] === bb[n]) {
				onKeep(aa[m], m + s, n + s, --idx);
				i--;
				j--;
			} else if (j > 0 && (i === 0 || c[i][n] >= c[m][j])) {
				adds.push([ n, idx, r ]);
				j--;
			} else if (i > 0 && (j === 0 || c[i][n] < c[m][j])) {
				onRemove(aa[m], m + s, --idx);
				r++;
				i--;
			} else {
				break;
			}
		}
		for (i = s - 1; i >= 0; i--) {
			onKeep(a[i], i, i, i);
		}

		// Do the adds
		let len = adds.length - 1;
		for (i = len; i >= 0; i--) {
			[ n, idx, j ] = adds[i];
			onAdd(bb[n], n + s, idx - r + j + len - i);
		}
	}

	_unsubscribe(ci) {
		if (!ci.subscribed) {
			if (this.stale && this.stale[ci.rid]) {
				this._tryDelete(ci);
			}
			return;
		}

		this._subscribeReferred(ci);

		this._send('unsubscribe', ci.rid)
			.then(() => {
				ci.setSubscribed(false);
				this._tryDelete(ci);
			})
			.catch(err => this._tryDelete(ci));
	}

	_subscribeReferred(ci) {
		ci.subscribed = false;
		let refs = this._getRefState(ci);
		ci.subscribed = true;

		for (let rid in refs) {
			let r = refs[rid];
			if (r.st === stateStale) {
				this._subscribe(r.ci);
			}
		}
	}

	_handleFailedSubscribe(cacheItem, err) {
		cacheItem.setSubscribed(false);
		this._tryDelete(cacheItem);
	}

	_reconnect() {
		setTimeout(() => {
			if (!this.tryConnect) {
				return;
			}

			this.connect();
		}, reconnectDelay);
	}

	_resolvePath(url) {
		if (url.match(/^wss?:\/\//) || typeof document == 'undefined' || !document.createElement) {
			return url;
		}

		let a = document.createElement('a');
		a.href = url;

		return a.href.replace(/^http/, 'ws');
	}

	_traverse(ci, cb, state, skipFirst = false) {
		// Call callback to get new state to pass to
		// children. If false, we should not traverse deeper
		if (!skipFirst) {
			state = cb(ci, state);
			if (state === false) {
				return;
			}
		}

		let item = ci.item;
		switch (ci.type) {
		case typeCollection:
			for (let v of item) {
				let ci = this._getRefItem(v);
				if (ci) {
					this._traverse(ci, cb, state);
				}
			}
			break;
		case typeModel:
			for (let k in item) {
				if (item.hasOwnProperty(k)) {
					let ci = this._getRefItem(item[k]);
					if (ci) {
						this._traverse(ci, cb, state);
					}
				}
			}
			break;
		}
	}
}

export default ResClient;

export function isResError(o) {
	return o instanceof ResError;
};
