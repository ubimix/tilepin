/** Map export in various formats (PNG, JPG, SVG, PDF...) */
var Path = require('path')
var FS = require('fs');
var Commons = require('./tilepin-commons');
var P = Commons.P;
var _ = require('underscore');

var mercator = new (require('sphericalmercator'));
var mapnik = require('mapnik');
var TileMillProjectLoader = require('./tilepin-loader');

module.exports = MapExport;

/**
 * 
 */
function MapExport(options) {
    this.options = options || {};
    this.projectLoader = this.options.projectLoader
            || new TileMillProjectLoader(this.options);
}
_.extend(MapExport.prototype, {

    generateMap : function(params) {
        var that = this;
        return P().then(function() {
            var format = params.format || 'pdf';
            var zoom = params.zoom;
            var fileDir = params.fileDir;
            var fileName = fileName;
            var scale = 1.0;
            var w = Math.min(params.west, params.east);
            var s = Math.min(params.north, params.south);
            var e = Math.max(params.west, params.east);
            var n = Math.max(params.north, params.south);
            var bbox = mercator.convert([ w, s, e, n ], '900913');

            var firstPoint = mercator.px([ w, s ], zoom);
            var secondPoint = mercator.px([ e, n ], zoom);
            var size = {
                width : Math.abs(firstPoint[0] - secondPoint[0]),
                height : Math.abs(firstPoint[1] - secondPoint[1])
            }

            var source = params.source || '';
            source = source.replace(/[\\\/\-&]/gim, '_');
            var outputFileName = 'map-' + source + '-' + zoom // 
                    + '-[' + bbox.join(',') + '].' + format;

            var outputFile = Path.join(fileDir, outputFileName);
            var mime = 'application/' + format;
            var filePromiseIndex = that._filePromiseIndex || {};
            that._filePromiseIndex = filePromiseIndex;
            var promise = filePromiseIndex[outputFile];
            if (!promise && FS.existsSync(outputFile)) {
                promise = P();
            }
            if (!promise) {
                promise = filePromiseIndex[outputFile] = // 
                that.projectLoader.loadProject(params) // 
                .then(function(uri) {
                    var options = _.extend({}, uri, size);
                    var map = new mapnik.Map(options.width, options.height);
                    map.extent = bbox;
                    return P.ninvoke(map, 'fromString', options.xml, options)//
                    .then(function(map) {
                        return P.ninvoke(map, 'renderFile', outputFile, {
                            format : format,
                            scale : scale
                        });
                    });
                }).then(function(result) {
                    delete filePromiseIndex[outputFile];
                    return result;
                });
            }
            return promise.then(function() {
                return P.ninvoke(FS, 'readFile', outputFile) //
                .then(function(buffer) {
                    return {
                        file : buffer,
                        filePath : outputFile,
                        fileName : fileName,
                        headers : {
                            'Content-Type' : mime
                        }
                    }
                })
            });
        })
    }

})
