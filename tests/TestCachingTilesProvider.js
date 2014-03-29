var expect = require('expect.js');
var Tilepin = require('../tilepin');
var $ = require('cheerio');
var _ = require('underscore');
var Q = require('q');
var FS = require('fs');

function TestTilesProvider(options) {
    this.options = options;
}
_.extend(TestTilesProvider.prototype, Tilepin.TilesProvider, {
    formats : [ 'foo' ],
    loadTile : function(params) {
        this._hits = this._hits || 0;
        this._hits++;
        return Q(this.options.name);
    },
    getHits : function() {
        return this._hits;
    }
});

describe('Tilepin', function() {
    it('should load external files', function(done) {
        var providers = {
            projectOne : new TestTilesProvider({
                name : 'one'
            }),
            projectTwo : new TestTilesProvider({
                name : 'two'
            }),
        }
        var provider = new Tilepin.CachingTilesProvider({
            provider : new Tilepin.DispatchingTilesProvider({
                getProvider : function(params) {
                    return Q(providers[params.source]);
                }
            })
        })
        var params = {
            source : 'projectOne',
            x : 1,
            y : 2,
            z : 3,
            format : 'foo'
        }
        return Q()
        // The first call hits the original source of tiles. Cache is not used.
        .then(function() {
            return provider.loadTile(params).then(function(result) {
                expect(result).to.eql('one');
                expect(providers.projectOne.getHits()).to.eql(1);
            });
        })
        // Reloads the tile; It should not hit the original tile source;
        // The result comes from the cache.
        .then(function() {
            return provider.loadTile(params).then(function(result) {
                expect(result).to.eql('one');
                expect(providers.projectOne.getHits()).to.eql(1);
            });
        })
        // Reset cache and load tiles again. It should hit the original source.
        .then(function() {
            return provider.invalidate(params).then(function() {
                return provider.loadTile(params).then(function(result) {
                    expect(result).to.eql('one');
                    expect(providers.projectOne.getHits()).to.eql(2);
                });
            });
        })
        //
        .fin(done).done();
    })

    it('should load external files', function(done) {
        var provider = new Tilepin.ProjectBasedTilesProvider({
            dir : './tests'
        });
        Q().then(function() {
            return provider.invalidate({
                source : 'project'
            });
        }).then(function() {
            return provider.loadTile({
                source : 'project',
                x : 0,
                y : 0,
                z : 1,
                format : 'tile'
            });
        }).then(function(info) {
            var file = './tile-1-0-0.png';
            return Q.ninvoke(FS, 'writeFile', file, info.tile);
        }).fin(done).done();
    });

});
