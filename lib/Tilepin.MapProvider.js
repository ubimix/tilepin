var Tilepin = module.exports = require('./Tilepin');

var _ = require('underscore');
var Pool = require('generic-pool').Pool;
var Mapnik = require('mapnik');
var FS = require('fs');
var Mercator = new (require('sphericalmercator'));

/**
 * This class instantiates and uses a pool of 'mapnik.Map' objects for one
 * Mapnik configuration XML file. It contains methods to build vector tiles from
 * datasources, to render vector tiles by applying CartoCSS styles and to render
 * images and PDFs directly from Mapnik configurations containing datasources
 * and CartoCSS styles.
 */
var MapProvider = Tilepin.MapProvider = Tilepin.Class.extend({

    /**
     * Initializes this instance.
     * 
     * @param options.xml
     *            Mapnik XML configuration
     * @param options.base
     *            (optional) base directory is used to resolve relative
     *            datasource and style references; by default the current
     *            directory is used; this parameter is not used if datasources
     *            and style do not contain references
     * @param options.width
     *            (optional) initial map width; 256 by default
     * @param options.width
     *            (optional) initial map height; 256 by default
     * @param options.bufferSize
     *            (optional) buffer size used to generate map; 128 by default
     */
    initialize : function(options) {
        var that = this;
        that.options = options || {};
        if (!that.options.xml)
            throw new Error('Mapnik XML configuration is not defined');
        if (!that.options.base)
            that.options.base = './';
        // Initial map size
        that.options.width = that.options.width || 256;
        that.options.height = that.options.height || 256;
        that.options.bufferSize = that.options.bufferSize || 128;
        MapProvider._initialize();
    },

    /** Closes this instance and destroyes all in-memory Map instances. */
    close : function() {
        var that = this;
        return Tilepin.P().then(function() {
            var pool = that._getPool(false);
            if (!pool)
                return;
            var deferred = Tilepin.P.defer();
            pool.drain(function() {
                pool.destroyAllNow(Tilepin.P.nresolver(deferred));
            });
            return deferred.promise;
        })
    },

    /**
     * Builds a vector tile corresponding the specified parameters. To execute
     * this method the underlying Mapnik configuration must have at least one
     * datasource definition, but CartoCSS styles are optionally (they are not
     * used to generate Vector Tiles).
     */
    buildVtile : function(params) {
        var that = this;
        return that._withMap(params, function(map) {
            var vtile = new Mapnik.VectorTile(0, 0, 0);
            return Tilepin.P.ninvoke(map, 'render', vtile)
        });
    },

    /**
     * Renders the specified vector tile using the internal Mapnik
     * configuration. This configuration should contain CartoCSS styles.
     * 
     * @param params.format
     *            format of the tile to render; possible values are 'png',
     *            'svg', 'jpeg', 'json'
     * @param params.size.width
     *            width of the resulting tile
     * @param params.size.height
     *            height of the resulting tile
     * @return an object containing two fields: a) data - the rendered tile b)
     *         headers - HTTP headers corresponding to the generated tile
     *         (content type of this tile)
     */
    renderVtile : function(params, vtile) {
        var that = this;
        return that._withMap(params, function(map) {
            var surface = that._getSurface(map, params);
            return Tilepin.P.ninvoke(vtile, 'render', map, surface.surface,
                    surface.options).then(function(image) {
                var format = params.format;
                if (format == 'svg') {
                    return image.getData();
                } else {
                    if (format == 'jpg')
                        format = 'jpeg';
                    return Tilepin.P.ninvoke(image, 'encode', format, {});
                }
            }).then(function(data) {
                var headers = that._getHeaders(params.format);
                return {
                    data : data,
                    headers : headers
                };
            });
        });
    },

    /**
     * Renders a specified geographic zone in one of the following formats:
     * "png", "jpeg", "svg", "pdf".
     * 
     * @param params.format
     *            export format; one of the following values: "png", "jpeg",
     *            "svg", "pdf"
     * @param params.file
     *            file where the exported map should be stored
     * @param params.size.width
     *            width of the generated map
     * @param params.size.height
     *            height of the generated map
     * @param params.zoom
     *            zoom level of the map to export; if this parameter is defined
     *            then width/height pair is optional and these values are
     *            calculated automoatically based on the zoom level and the
     *            exported bounding box
     * @param params.minX
     *            west limit of the exported zone
     * @param params.minY
     *            south limit of the exported zone
     * @param params.maxX
     *            eash limit of the exported zone
     * @param params.maxY
     *            north limit of the exported zone
     * @param params.bbox
     *            bounding box to export; this parameter is used only if
     *            previous parameters (minX, minY, maxX, maxY) are not defined
     */
    renderMapToFile : function(params) {
        var that = this;
        return Tilepin.P().then(function() {
            var outputFile = params.file;
            if (!outputFile)
                throw new Error('File name is not defined');
            var format = params.format || 'pdf';
            return that._withMap(params, function(map) {
                var filePromiseIndex = that._filePromiseIndex || {};
                that._filePromiseIndex = filePromiseIndex;
                var promise = filePromiseIndex[outputFile];
                if (!promise) {
                    var scale = params.scale || 1.0;
                    promise = filePromiseIndex[outputFile] = //
                    Tilepin.P().then(function() {
                        return Tilepin.P//
                        .ninvoke(map, 'renderFile', outputFile, {
                            format : format,
                            scale : scale
                        });
                    }).then(function(result) {
                        delete filePromiseIndex[outputFile];
                        return result;
                    }, function(err) {
                        delete filePromiseIndex[outputFile];
                        throw err;
                    });
                }
                return promise.then(function() {
                    var mime;
                    switch (format) {
                    case 'png':
                        mime = 'image/png';
                        break;
                    case 'pdf':
                        mime = 'application/pdf';
                        break;
                    case 'svg':
                        mime = 'image/svg+xml';
                        break;
                    }
                    return {
                        file : outputFile,
                        headers : {
                            'Content-Type' : mime
                        }
                    };
                });
            });
        });
    },

    /**
     * Returns a "surface" used to render vector tiles. Possible values are
     * Mapnik.Grid (for UTFGrid generation), Mapnik.CarioSurface (for SVG
     * generation) or Mapnik.Image (for PNG/JPEG tiles).
     * 
     * @return an object containing a) "surface" field b) "options" field used
     *         as a parameter for vector tile rendering.
     */
    _getSurface : function(map, params) {
        var format = params.format;
        var width = params.size.width;
        var height = params.size.height;
        var surface;
        var options = {};
        if (format === 'utf') {
            surface = new Mapnik.Grid(width, height);
            var parameters = map.parameters;
            if (parameters) {
                options.layer = parameters.interactivity_layer;
                var fields = parameters.interactivity_fields;
                if (_.isString(fields)) {
                    fields = fields.replace(/\s*/gim, '');
                    fields = fields.split(/[,;]/im);
                } else {
                    fields = _.toArray(map.parameters.interactivity_fields);
                }
                options.fields = fields;
            }
        } else if (format === 'svg') {
            surface = new Mapnik.CairoSurface('svg', width, height);
        } else {
            surface = new Mapnik.Image(width, height);
        }
        return {
            surface : surface,
            options : options
        }
    },

    /** Returns HTTP headers (Content-Type) corresponding to the specified format */
    _getHeaders : function(format) {
        var contentType;
        switch (format.match(/^[a-z]+/i)[0]) {
        case 'json':
        case 'utf':
            contentType = 'application/json';
            break;
        case 'jpeg':
        case 'jpg':
            contentType = 'image/jpeg';
            break;
        case 'svg':
            contentType = 'image/svg+xml';
            break;
        case 'png':
        default:
            contentType = 'image/png';
            break;
        }
        var headers = {
            'Content-Type' : contentType
        };
        return headers;
    },

    /**
     * This is an utility method used to lock a Mapnik map instance from the
     * internal pool and execute the specified action. After that this method
     * returns (unlocks) the map to the pool.
     */
    _withMap : function(params, action) {
        var that = this;
        var pool = that._getPool();
        return MapProvider.runWithPooledObject(pool, function(map) {
            params = that._checkMapParams(params);
            map.resize(params.size.width, params.size.height);
            map.extent = params.bbox;
            return action(map);
        });
    },

    /**
     * Checks/calculates mandatory map parameters like map size and bounding
     * box.
     */
    _checkMapParams : function(params) {
        // Checks the bounding box
        var bbox = params.bbox;
        if (!bbox) {
            bbox = MapProvider.getBoundingBox(params);
        }
        params.bbox = bbox;

        // Check map size
        var size = params.size;
        if (!size && params.width && params.height) {
            size = {
                width : params.width,
                height : params.height
            }
        }
        if (!size && params.zoom !== undefined) {
            size = MapProvider.getMapSizeFromBoundingBox(params.zoom, bbox);
        }
        params.size = size;
        return params;
    },

    /** Returns a pool of Mapnik map objects. */
    _getPool : function(create) {
        var that = this;
        if (!that._pool && create !== false) {
            that._pool = Pool({
                /** This method creates a new map instance */
                create : function(callback) {
                    var map = new Mapnik.Map(that.options.width,
                            that.options.height);
                    map.bufferSize = that.options.bufferSize;
                    return Tilepin.P.ninvoke(map, 'fromString',
                            that.options.xml, {
                                strict : !!that.options.strict,
                                base : that.options.base + '/'
                            }).then(function(result) {
                        callback(null, result);
                    }, callback);
                },
                /** Destroyes the specified map */
                destroy : function(map) {
                    delete map;
                },
                /**
                 * Returns the maximal number of map instances. By defaults it
                 * is the number of processors.
                 */
                max : require('os').cpus().length
            });
        }
        return that._pool;
    }

});

// Static methods
_.extend(MapProvider, {

    /**
     * Initializes default Mapnik fonts and plugins. This method performs
     * registration just once.
     */
    _initialize : function() {
        if (this._initialized)
            return;
        // register fonts and datasource plugins
        Mapnik.register_default_fonts();
        Mapnik.register_default_input_plugins();
        this._initialized = true;
    },

    /**
     * Returns a bounding box in the spherical mercator coordinates using the
     * specified parameters.
     * 
     * @param params.minX
     * @param params.minY
     * @param params.maxX
     * @param params.maxY
     */
    getBoundingBox : function(params) {
        var w = Math.min(params.minX, params.maxX);
        var s = Math.min(params.maxY, params.minY);
        var e = Math.max(params.minX, params.maxX);
        var n = Math.max(params.maxY, params.minY);
        var bbox = Mercator.convert([ w, s, e, n ], '900913');
        return bbox;
    },

    /**
     * Return a size of the final rendered map (in pixels) for the specified
     * zoom level for the bounding box (in spherical mercator projection).
     * 
     * @param zoom
     *            zoom level
     * @param bbox
     *            a bounding box in spherical mercator projection (minX=bbox[0],
     *            minY=bbox[1], maxX=bbox[2], maxY=bbox[3])
     */
    getMapSizeFromBoundingBox : function(zoom, bbox) {
        var w = bbox[0];
        var s = bbox[1];
        var e = bbox[2];
        var n = bbox[3];
        var firstPoint = Mercator.px(Mercator.inverse([ w, s ]), zoom);
        var secondPoint = Mercator.px(Mercator.inverse([ e, n ]), zoom);
        var size = {
            width : Math.abs(firstPoint[0] - secondPoint[0]),
            height : Math.abs(firstPoint[1] - secondPoint[1])
        }
        return size;
    },

    /**
     * Executes an action after locking an instance from the given object pool.
     * The locked instance is automatically released after action finishing. It
     * is expected that the action is synchronous or it returns a promise.
     */
    runWithPooledObject : function(pool, action) {
        var obj;
        return Tilepin.P.fin(Tilepin.P.ninvoke(pool, 'acquire').then(
                function(o) {
                    obj = o;
                    return action(obj);
                }), function() {
            if (obj) {
                Tilepin.P.ninvoke(pool, 'release', obj).done();
            }
        });
    },

    /** Serializes the specified vector tile object and returns a data buffer. */
    serializeVtile : function(vtile) {
        return Tilepin.P(vtile.getData());
    },

    /**
     * Creates and returns a new vector tile object using the specified data
     * buffer.
     */
    parseVtile : function(data, size) {
        var vtile = new Mapnik.VectorTile(0, 0, 0, size);
        return Tilepin.P.ninvoke(vtile, 'setData', data).then(function() {
            return Tilepin.P.ninvoke(vtile, 'parse').then(function() {
                return vtile;
            })
        });
    },

})
