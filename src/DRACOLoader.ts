import { fileURLToPath } from 'node:url';
import { dirname, sep } from 'node:path';
import { Worker } from 'node:worker_threads';
import {
	BufferAttribute,
	BufferGeometry,
	Loader, LoadingManager
} from 'three';
import { FileLoader } from './FileLoader';

const _taskCache = new WeakMap();

export class DRACOLoader extends Loader<BufferGeometry> {

	decoderPath = dirname(fileURLToPath(import.meta.url)) + sep;
	decoderConfig: { [key: string]: any } = {};
	decoderPending = null;

	workerLimit = 4;
	workerPool = [];
	workerNextTaskID = 1;
	workerSourceURL = '';

	defaultAttributeIDs = {
		position: 'POSITION',
		normal: 'NORMAL',
		color: 'COLOR',
		uv: 'TEX_COORD'
	};
	defaultAttributeTypes = {
		position: 'Float32Array',
		normal: 'Float32Array',
		color: 'Float32Array',
		uv: 'Float32Array'
	};

	constructor( manager?: LoadingManager ) {

		super( manager );

	}

	setDecoderConfig( config: object ) {

		this.decoderConfig = config;

		return this;

	}

	setWorkerLimit( workerLimit: number ) {

		this.workerLimit = workerLimit;

		return this;

	}

	load( url: string, onLoad: (geometry: BufferGeometry) => void, onProgress?: (event: ProgressEvent) => void, onError?: (err: Error) => void ) {

		const loader = new FileLoader( this.manager );

		loader.setPath( this.path );
		loader.setResponseType( 'arraybuffer' );
		loader.setRequestHeader( this.requestHeader );
		loader.setWithCredentials( this.withCredentials );

		loader.load( url, ( buffer ) => {

			const taskConfig = {
				attributeIDs: this.defaultAttributeIDs,
				attributeTypes: this.defaultAttributeTypes,
				useUniqueIDs: false
			};

			// @ts-ignore
			this.decodeGeometry( buffer, taskConfig )
				.then( onLoad )
				.catch( onError );

		}, onProgress, onError );

	}

	decodeDracoFile( buffer: ArrayBuffer, callback: (geometry: BufferGeometry) => void, attributeIDs?, attributeTypes? ) {

		const taskConfig = {
			attributeIDs: attributeIDs || this.defaultAttributeIDs,
			attributeTypes: attributeTypes || this.defaultAttributeTypes,
			useUniqueIDs: !! attributeIDs
		};

		this.decodeGeometry( buffer, taskConfig ).then( callback );

	}

	decodeGeometry( buffer: ArrayBuffer, taskConfig ): Promise<BufferGeometry> {

		const taskKey = JSON.stringify( taskConfig );

		// Check for an existing task using this buffer. A transferred buffer cannot be transferred
		// again from this thread.
		if ( _taskCache.has( buffer ) ) {

			const cachedTask = _taskCache.get( buffer );

			if ( cachedTask.key === taskKey ) {

				return cachedTask.promise;

			} else if ( buffer.byteLength === 0 ) {

				// Technically, it would be possible to wait for the previous task to complete,
				// transfer the buffer back, and decode again with the second configuration. That
				// is complex, and I don't know of any reason to decode a Draco buffer twice in
				// different ways, so this is left unimplemented.
				throw new Error(

					'THREE.DRACOLoader: Unable to re-decode a buffer with different ' +
					'settings. Buffer has already been transferred.'

				);

			}

		}

		let worker;
		const taskID = this.workerNextTaskID ++;
		const taskCost = buffer.byteLength;

		// Obtain a worker and assign a task, and construct a geometry instance
		// when the task completes.
		const geometryPending = this._getWorker( taskID, taskCost )
			.then( ( _worker ) => {

				worker = _worker;

				return new Promise( ( resolve, reject ) => {

					worker._callbacks[ taskID ] = { resolve, reject };

					worker.postMessage( { type: 'decode', id: taskID, taskConfig, buffer }, [ buffer ] );

					// this.debug();

				} );

			} )
			.then( ( message ) => this._createGeometry( message.geometry ) );

		// Remove task from the task list.
		// Note: replaced '.finally()' with '.catch().then()' block - iOS 11 support (#19416)
		geometryPending
			.catch( () => true )
			.then( () => {

				if ( worker && taskID ) {

					this._releaseTask( worker, taskID );

					// this.debug();

				}

			} );

		// Cache the task result.
		_taskCache.set( buffer, {

			key: taskKey,
			promise: geometryPending

		} );

		return geometryPending;

	}

	_createGeometry( geometryData ): BufferGeometry {

		const geometry = new BufferGeometry();

		if ( geometryData.index ) {

			geometry.setIndex( new BufferAttribute( geometryData.index.array, 1 ) );

		}

		for ( const attribute of geometryData.attributes ) {

			const name = attribute.name;
			const array = attribute.array;
			const itemSize = attribute.itemSize;

			geometry.setAttribute( name, new BufferAttribute( array, itemSize ) );

		}

		return geometry;

	}

	preload() {

		this._initDecoder();

		return this;

	}

	_loadLibrary(url: string, responseType: string) {

		const loader = new FileLoader( this.manager );
		loader.setPath( this.decoderPath );
		loader.setResponseType( responseType );
		loader.setWithCredentials( this.withCredentials );

		return new Promise(( resolve, reject ) => {

			loader.load( url, resolve, undefined, reject );

		});

	}

	_initDecoder() {

		if ( this.decoderPending ) return this.decoderPending;

		const useJS = typeof WebAssembly !== 'object' || this.decoderConfig.type === 'js';

		if ( useJS ) {

			this.workerSourceURL = this.decoderPath + 'draco_worker.js';

			this.decoderPending = Promise.resolve();

		} else {

			this.workerSourceURL = this.decoderPath + 'draco_worker_wasm.js';

			this.decoderPending = this._loadLibrary( 'draco_decoder.wasm', 'arraybuffer' )
				.then( ( wasmBinary ) => {

					this.decoderConfig.wasmBinary = wasmBinary;

				} );

		}

		return this.decoderPending;

	}

	_getWorker( taskID, taskCost ) {

		return this._initDecoder().then( () => {

			if ( this.workerPool.length < this.workerLimit ) {

				const worker = new Worker( this.workerSourceURL );

				// @ts-ignore
				worker._callbacks = {};
				// @ts-ignore
				worker._taskCosts = {};
				// @ts-ignore
				worker._taskLoad = 0;

				worker.postMessage( { type: 'init', decoderConfig: this.decoderConfig } );

				worker.on('message', ( message ) => {

					switch ( message.type ) {

						case 'decode':
							// @ts-ignore
							worker._callbacks[ message.id ].resolve( message );
							break;

						case 'error':
							// @ts-ignore
							worker._callbacks[ message.id ].reject( message );
							break;

						default:
							console.error( 'THREE.DRACOLoader: Unexpected message, "' + message.type + '"' );

					}

				} );

				this.workerPool.push( worker );

			} else {

				this.workerPool.sort( function ( a, b ) {

					return a._taskLoad > b._taskLoad ? - 1 : 1;

				} );

			}

			const worker = this.workerPool[ this.workerPool.length - 1 ];
			worker._taskCosts[ taskID ] = taskCost;
			worker._taskLoad += taskCost;
			return worker;

		} );

	}

	_releaseTask( worker, taskID ) {

		worker._taskLoad -= worker._taskCosts[ taskID ];
		delete worker._callbacks[ taskID ];
		delete worker._taskCosts[ taskID ];

	}

	dispose() {

		for ( let i = 0; i < this.workerPool.length; ++ i ) {

			this.workerPool[ i ].terminate();

		}

		this.workerPool.length = 0;

		return this;

	}

}
