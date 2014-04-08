var expect = require('expect.js');
var $ = require('cheerio');
var _ = require('underscore');
var P = require('../tilepin-commons').P;
var FS = require('fs');
var Path = require('path');
var TileSourceProvider = require('../tilepin-provider');

describe('TileSourceProvider', function() {

    var projectFile = Path.join(__dirname, 'project/project.tilepin.xml');

    describe('TileSourceProvider.TileMillSourceProvider', function() {

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
        it('should be able generate a new tile source for each type', function(
                done) {
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
                            expect(info).not.to.be(null);
                            expect(info.tile).not.to.be(null);
                            expect(info.headers).not.to.be(null);
                            // console.log(info);
                        })
                    })
                })
            });
            return promise.fin(done).done();
        })
    })

    describe('TileSourceProvider.CachingTileSourceProvider', function() {

        var projectFile = Path.join(__dirname, 'project/project.tilepin.xml');
        var formats = [ 'png', 'grid.json', 'pbf', 'svg', 'pdf' ];

        var traces = '';
        var provider;
        beforeEach(function() {
            provider = new TileSourceProvider.TileMillSourceProvider({
                dir : __dirname
            })
            provider = TileSourceProvider.CachingTileSourceProvider
                    .wrap(provider);
            function setListeners(obj, events) {
                traces = '';
                _.each(events, function(name) {
                    if (name.match(/\:end$/gim)) {
                        obj.on(name, function(ev) {
                            traces += '</'
                                    + name.substring(0, name.length
                                            - ':end'.length) + '>'
                        })
                    } else if (name.match(/\:begin$/gim)) {
                        obj.on(name, function(ev) {
                            traces += '<'
                                    + name.substring(0, name.length
                                            - ':begin'.length) + '>'
                        })
                    } else {
                        obj.on(name, function(ev) {
                            traces += '<' + name + '/>';
                        })
                    }
                })
            }
            setListeners(provider, [ 'loadTileSource:begin',
                    'loadTileSource:end', 'loadFromCache', 'missedInCache',
                    'setInCache' ])
        });
        var params = {
            source : 'project',
            format : 'png'
        };

        it('should be able to manage cached tilesources', function(done) {
            return P()
            // Initial source loading. The requested tile source is not in the
            // cache.
            .then(
                    function() {
                        return provider.loadTileSource(params).then(
                                function(tileSource) {
                                    expect(tileSource).not.to.be(null);
                                    expect(traces).to.eql('<loadTileSource>'
                                            + '<missedInCache/>'
                                            + '<setInCache/>'
                                            + '</loadTileSource>');
                                    traces = '';
                                }).then(function() {
                            return provider.loadTileSource(params);
                        });
                    })
            // Load the tile source from the cache
            .then(
                    function(tileSource) {
                        expect(tileSource).not.to.be(null);
                        expect(traces).to.eql('<loadTileSource>'
                                + '<loadFromCache/>' + '</loadTileSource>');
                        traces = '';
                    })
            // Clean up the cache. It should tore-load the source.
            .then(
                    function() {
                        expect(FS.existsSync(projectFile)).to.be(true);
                        return provider.clearTileSource(params) //
                        .then(function() {
                            traces = '';
                            expect(FS.existsSync(projectFile)).to.be(false);
                            return provider.loadTileSource(params);
                        }) //
                        .then(
                                function(tileSource) {
                                    expect(FS.existsSync(projectFile)).to
                                            .be(true);
                                    expect(tileSource).not.to.be(null);
                                    expect(traces).to.eql('<loadTileSource>'
                                            + '<missedInCache/>'
                                            + '<setInCache/>'
                                            + '</loadTileSource>');
                                    traces = '';
                                });
                    })
            // Finish
            .fin(done).done();
        })
    })
});