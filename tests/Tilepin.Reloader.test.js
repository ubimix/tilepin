var expect = require('expect.js');
var _ = require('underscore');
var FS = require('fs');
var Path = require('path');
var Reloader = require('../lib/Tilepin.Reloader.js');

describe('Tilepin.Reloader', function() {
    it('should add new methods "uncache" et "reload"', function() {
        var reloader = new Reloader(require);
        
        var testModule = require('./Tilepin.Reloader.module');
        expect(testModule.incCounter()).to.eql(1);
        expect(testModule.incCounter()).to.eql(2);
        expect(testModule.incCounter()).to.eql(3);
        testModule = require('./Tilepin.Reloader.module');
        expect(testModule.incCounter()).to.eql(4);
        expect(testModule.incCounter()).to.eql(5);
        expect(testModule.incCounter()).to.eql(6);
        
        reloader.reload('./Tilepin.Reloader.module');

        testModule = require('./Tilepin.Reloader.module');
        expect(testModule.incCounter()).to.eql(1);
        expect(testModule.incCounter()).to.eql(2);
        expect(testModule.incCounter()).to.eql(3);
        testModule = require('./Tilepin.Reloader.module');
        expect(testModule.incCounter()).to.eql(4);
        expect(testModule.incCounter()).to.eql(5);
        expect(testModule.incCounter()).to.eql(6);
    });
});
