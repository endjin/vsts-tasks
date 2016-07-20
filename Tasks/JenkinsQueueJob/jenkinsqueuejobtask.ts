// Copyright (c) Microsoft. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.

/// <reference path="../../definitions/node.d.ts"/>
/// <reference path="../../definitions/vsts-task-lib.d.ts" />
/// <reference path="../../definitions/shelljs.d.ts"/>

import tl = require('vsts-task-lib/task');
import fs = require('fs');
import path = require('path');
import shell = require('shelljs');

// node js modules
var request = require('request');

import job = require('./job');
import Job = job.Job;
import jobqueue = require('./jobqueue');
import JobQueue = jobqueue.JobQueue;
import util = require('./util');

var serverEndpoint = tl.getInput('serverEndpoint', true);
var serverEndpointUrl = tl.getEndpointUrl(serverEndpoint, false);
tl.debug('serverEndpointUrl=' + serverEndpointUrl);

var serverEndpointAuth = tl.getEndpointAuthorization(serverEndpoint, false);
var username = serverEndpointAuth['parameters']['username'];
var password = serverEndpointAuth['parameters']['password'];

var jobName = tl.getInput('jobName', true);

var captureConsole: boolean = tl.getBoolInput('captureConsole', true);
// capturePipeline is only possible if captureConsole mode is enabled
var capturePipeline: boolean = captureConsole ? tl.getBoolInput('capturePipeline', true) : false;

var pollInterval: number = 5000; // five seconds is what the Jenkins Web UI uses

var parameterizedJob = tl.getBoolInput('parameterizedJob', true);

var jobQueueUrl = util.addUrlSegment(serverEndpointUrl, '/job/' + jobName);
jobQueueUrl += (parameterizedJob) ? '/buildWithParameters?delay=0sec' : '/build?delay=0sec';
tl.debug('jobQueueUrl=' + jobQueueUrl);

var jobQueue: JobQueue = new JobQueue(username, password, captureConsole, capturePipeline, pollInterval);

function trackJobQueued(queueUri: string) {
    tl.debug('trackJobQueued()');
    tl.debug('Tracking progress of job queue: ' + queueUri);
    request.get({ url: queueUri }, function requestCallback(err, httpResponse, body) {
        tl.debug('trackJobQueued().requestCallback()');
        if (err) {
            util.fail(err);
        } else if (httpResponse.statusCode != 200) {
            util.failReturnCode(httpResponse, 'Job progress tracking failed to read job queue');
        } else {
            var parsedBody = JSON.parse(body);
            tl.debug("parsedBody for: " + queueUri + ": " + JSON.stringify(parsedBody));

            // canceled is spelled wrong in the body with 2 Ls (checking correct spelling also in case they fix it)
            if (parsedBody.cancelled || parsedBody.canceled) {
                tl.setResult(tl.TaskResult.Failed, 'Jenkins job canceled.');
                tl.exit(1);
            }
            var executable = parsedBody.executable;
            if (!executable) {
                // job has not actually been queued yet, keep checking
                setTimeout(function () {
                    trackJobQueued(queueUri);
                }, pollInterval);
            } else {
                var rootJob: Job = new Job(jobQueue, null, parsedBody.task.url, parsedBody.executable.url, parsedBody.executable.number, parsedBody.task.name);
                jobQueue.start();
            }
        }
    }).auth(username, password, true);
}


/**
 * Supported parameter types: boolean, string, choice, password
 * 
 * - If a parameter is not defined by Jenkins it is fine to pass it anyway
 * - Anything passed to a boolean parameter other than 'true' (case insenstive) becomes false.
 * - Invalid choice parameters result in a 500 response.
 * 
 */
function parseJobParameters() {
    var formData = {};
    var jobParameters: string[] = tl.getDelimitedInput('jobParameters', '\n', false);
    for (var i = 0; i < jobParameters.length; i++) {
        var paramLine = jobParameters[i];
        var splitIndex = paramLine.indexOf('=');
        if (splitIndex <= 0) { // either no paramValue (-1), or no paramName (0)
            util.fail('Job parameters should be specified as "parameterName=parameterValue" with one name, value pair per line. Invalid parameter line: ' + paramLine);
        }
        var paramName = paramLine.substr(0, splitIndex);
        var paramValue = paramLine.slice(splitIndex + 1);
        formData[paramName] = paramValue;
    }
    return formData;
}

var initialPostData = parameterizedJob ?
    { url: jobQueueUrl, formData: parseJobParameters() } :
    { url: jobQueueUrl };

tl.debug('initialPostData = ' + JSON.stringify(initialPostData));

request.post(initialPostData, function optionalCallback(err, httpResponse, body) {
    if (err) {
        util.fail(err);
    } else if (httpResponse.statusCode != 201) {
        util.failReturnCode(httpResponse, 'Job creation failed.');
    } else {
        console.log('Jenkins job queued');
        var queueUri = util.addUrlSegment(httpResponse.headers.location, 'api/json');
        trackJobQueued(queueUri);
    }
}).auth(username, password, true);