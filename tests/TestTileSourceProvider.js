var expect = require('expect.js');
var $ = require('cheerio');
var _ = require('underscore');
var P = require('../tilepin-commons').P;
var FS = require('fs');
var Path = require('path');
var TileSourceProvider = require('../tilepin-provider');

describe('TileSourceProvider', function() {

    var projectFile = Path.join(__dirname, 'project/project.tilepin.xml');
    var formats = [ 'png', 'grid.json', 'pbf', 'svg', 'pdf' ];

    var provider;
    beforeEach(function() {
        provider = new TileSourceProvider.TileMillSourceProvider({
            dir : __dirname
        });
    });
    function loadSource(format) {
        var params = {
            source : 'project',
            format : format
        };
        var promise = provider.loadTileSource(params).then(
                function(tileSource) {
                    expect(tileSource).not.to.be(null);
                    return tileSource;
                });
        return promise;
    }
    it('should be able generate a new tile source for each type',
            function(done) {
                return P.all(_.map(formats, function(format) {
                    return loadSource(format);
                })).fin(done).done();
            })

    it('should be able generate tiles from tilesources', function(done) {
        function buildTile(tileSource, params) {
            var deferred = P.defer();
            try {
                var format = params.format;
                var z = params.z;
                var x = +params.x;
                var y = +params.y;
                var fn = format === 'grid.json' ? 'getGrid' : 'getTile';
                tileSource[fn](z, x, y, function(err, tile, headers) {
                    if (err) {
                        deferred.reject(err);
                    } else {
                        deferred.resolve({
                            tile : tile,
                            headers : headers
                        })
                    }
                })
            } catch (e) {
                deferred.reject(e);
            }
            return deferred.promise;
        }
        var promise = P();
        _.each([ 'vtile', 'grid.json', 'png' ], function(format) {
            promise = promise.then(function() {
                return loadSource(format).then(function(tileSource) {
                    return buildTile(tileSource, {
                        format : format,
                        z : 1,
                        x : 0,
                        y : 0
                    }).then(function(info) {
                        console.log(info);
                    })
                })
            })
        });
        return promise.fin(done).done();
    })
})