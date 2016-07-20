// Copyright (c) Microsoft. All rights reserved.
// Licensed under the MIT license. See LICENSE file in the project root for full license information.

/// <reference path="../../definitions/node.d.ts"/>
/// <reference path="../../definitions/vsts-task-lib.d.ts" />
/// <reference path="../../definitions/shelljs.d.ts"/>

import tl = require('vsts-task-lib/task');
import fs = require('fs');
import path = require('path');
import shell = require('shelljs');
import Q = require('q');


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

function pollCreateRootJob(queueUri: string): Q.Promise<Job> {
    var defer: Q.Deferred<Job> = Q.defer<Job>();

    var poll = async () => {
        await createRootJob(queueUri).then((job: Job) => {
            if (job != null) {
                defer.resolve(job);
            } else {
                // no job yet, but no failure either, so keep trying
                setTimeout(poll, pollInterval);
            }
        }).fail((err: any) => {
            defer.reject(err);
        })
    };

    poll();

    return defer.promise;
}

function createRootJob(queueUri: string): Q.Promise<Job> {
    var defer: Q.Deferred<Job> = Q.defer<Job>();
    tl.debug('createRootJob(): ' + queueUri);

    request.get({ url: queueUri }, function requestCallback(err, httpResponse, body) {
        tl.debug('createRootJob().requestCallback()');
        if (err) {
            if (err.code == 'ECONNRESET') {
                tl.debug(err);
                defer.resolve(null);
            } else {
                defer.reject(err);
            }
        } else if (httpResponse.statusCode != 200) {
            defer.reject(util.getFullErrorMessage(httpResponse, 'Job progress tracking failed to read job queue'));
        } else {
            var parsedBody = JSON.parse(body);
            tl.debug("parsedBody for: " + queueUri + ": " + JSON.stringify(parsedBody));

            // canceled is spelled wrong in the body with 2 Ls (checking correct spelling also in case they fix it)
            if (parsedBody.cancelled || parsedBody.canceled) {
                defer.reject('Jenkins job canceled.');
            } else {
                var executable = parsedBody.executable;
                if (!executable) {
                    // job has not actually been queued yet
                    defer.resolve(null);
                } else {
                    var rootJob: Job = new Job(jobQueue, null, parsedBody.task.url, parsedBody.executable.url, parsedBody.executable.number, parsedBody.task.name);
                    defer.resolve(rootJob);
                }
            }
        }
    }).auth(username, password, true);

    return defer.promise;
}

function pollSubmitJob(initialPostData): Q.Promise<string> {
    var defer: Q.Deferred<string> = Q.defer<string>();

    var poll = async () => {
        await submitJob(initialPostData).then((queueUri: string) => {
            if (queueUri != null) {
                defer.resolve(queueUri);
            } else {
                // no queueUri yet, but no failure either, so keep trying
                setTimeout(poll, pollInterval);
            }
        }).fail((err: any) => {
            defer.reject(err);
        })
    };

    poll();

    return defer.promise;
}

function submitJob(initialPostData): Q.Promise<string> {
    var defer: Q.Deferred<string> = Q.defer<string>();
    tl.debug('submitJob(): ' + JSON.stringify(initialPostData));

    request.post(initialPostData, function requestCallback(err, httpResponse, body) {
        tl.debug('submitJob().requestCallback()');
        if (err) {
            if (err.code == 'ECONNRESET') {
                tl.debug(err);
                defer.resolve(null);
            } else {
                defer.reject(err);
            }
        } else if (httpResponse.statusCode != 201) {
            defer.reject(util.getFullErrorMessage(httpResponse, 'Job creation failed.'));
        } else {
            var queueUri = util.addUrlSegment(httpResponse.headers.location, 'api/json');
            defer.resolve(queueUri);
        }
    }).auth(username, password, true);

    return defer.promise;
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
            throw 'Job parameters should be specified as "parameterName=parameterValue" with one name, value pair per line. Invalid parameter line: ' + paramLine;
        }
        var paramName = paramLine.substr(0, splitIndex);
        var paramValue = paramLine.slice(splitIndex + 1);
        formData[paramName] = paramValue;
    }
    return formData;
}

async function doWork() {
    try {
        var initialPostData = parameterizedJob ?
            { url: jobQueueUrl, formData: parseJobParameters() } :
            { url: jobQueueUrl };

        tl.debug('initialPostData = ' + JSON.stringify(initialPostData)); var queueUri = await pollSubmitJob(initialPostData);
        console.log('Jenkins job queued');
        var rootJob = await pollCreateRootJob(queueUri);
        jobQueue.start();
    } catch (e) {
        tl.debug(e.message);
        tl.setResult(tl.TaskResult.Failed, e.message);
    }

}

doWork();