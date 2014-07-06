var expect = require('expect.js');
var _ = require('underscore');
var Path = require('path');
var Tilepin = require('../lib/');

var TileSourceManager = require('../tilepin-provider');

var projectsDir = Path.join(__dirname, 'projects');
var options = {
    dir : projectsDir
};

describe('TileSourceManager', function() {
    var manager;
    beforeEach(function() {
        manager = new TileSourceManager(options);
    });

    it('should be able to load and return a tile source provider',
            suite(function() {
                return manager.loadTileSourceProvider({
                    source : '01-simple-tilemill-project'
                }).then(
                        function(provider) {
                            expect(provider).not.to.be(null);
                            expect(_.isFunction(provider.prepareTileSource)).to
                                    .be(true);
                            expect(_.isFunction(provider.close)).to.be(true);
                        });
            }));

    it('should return the same TileSourceProviders '
            + 'for the same source key',//
    suite(function() {
        var params = {
            source : '01-simple-tilemill-project'
        };
        function load(count) {
            var promises = [];
            for (var i = 0; i < count; i++) {
                var p = manager.loadTileSourceProvider(params);
                promises.push(p);
            }
            return Tilepin.P.all(promises);
        }
        function test(count, control, providers) {
            expect(providers).not.to.be(null);
            expect(providers.length).eql(count);
            _.each(providers, function(provider) {
                expect(provider).to.be(control);
            });
        }
        var control;
        var count = 100;
        return Tilepin.P().then(function() {
            return manager.loadTileSourceProvider(params);
        }).then(function(provider) {
            control = provider;
            return load(count);
        }).then(function(providers) {
            test(count, control, providers);
            return control.clear().then(function() {
                return load(count);
            }).then(function(providers) {
                return test(count, control, providers);
            })
        });
    }));

    it('tile source provider ' + 'should create tile source instances', //
    suite(function() {
        return manager.loadTileSourceProvider({
            source : '01-simple-tilemill-project'
        }).then(function(provider) {
            return provider.prepareTileSource({}).then(function(tileSource) {
                expect(tileSource).not.to.be(null);
                expect(_.isFunction(tileSource.getTile)).to.be(true);
                expect(_.isFunction(tileSource.getInfo)).to.be(true);
            });
        });
    }));

    it('tile sources should build images', //
    suite(function(done) {
        return manager.loadTileSourceProvider({
            source : '01-simple-tilemill-project'
        }).then(function(provider) {
            return provider.prepareTileSource({}).then(function(tileSource) {
                expect(tileSource).not.to.be(null);
            });
        });
    }));
});


function suite(test) {
    return function(done) {
        return Tilepin.P().then(test).then(done, function(err) {
            done();
            throw err;
        }).done();
    }
}