var expect = require('expect.js');
var _ = require('underscore');
var Path = require('path');

var ProjectManager = require('../tilepin-provider');

var projectsDir = Path.join(__dirname, 'projects');
var options = {
    dir : projectsDir
};

describe('ProjectManager', function() {
    var manager;
    beforeEach(function() {
        manager = new ProjectManager(options);
    });

    it('should be able to load and return a tile source provider', function(
            done) {
        manager.loadTileSourceProvider({
            source : 'project-01'
        }).then(function(provider) {
            expect(provider).not.to.be(null);
            expect(_.isFunction(provider.prepareTileSource)).to.be(true);
            expect(_.isFunction(provider.close)).to.be(true);
        }).fin(done).done();
    });

    it('tile source provider should create tile source instances', function(
            done) {
        manager.loadTileSourceProvider({
            source : 'project-01'
        }).then(function(provider) {
            return provider.prepareTileSource({}).then(function(tileSource) {
                expect(tileSource).not.to.be(null);
                expect(_.isFunction(tileSource.getTile)).to.be(true);
                expect(_.isFunction(tileSource.getInfo)).to.be(true);
            });
        }).fin(done).done();
    });

    it('tile sources should build images', function(done) {
        manager.loadTileSourceProvider({
            source : 'project-01'
        }).then(function(provider) {
            return provider.prepareTileSource({}).then(function(tileSource) {
                expect(tileSource).not.to.be(null);
            });
        }).fin(done).done();
    });
});